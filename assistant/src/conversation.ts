import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import type { LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { Streams, sseResponse } from "agents/streams";
import type { StreamJson, StreamWriter } from "agents/streams";
import type { LanguageModel, ModelMessage } from "ai";

import type { Binding } from "./auth.js";
import { MAX_SAID, MAX_TURNS, Said, WIRE_VERSION } from "./catalogue/wire.js";
import type { Notice, Refusal } from "./catalogue/wire.js";
import type { Env } from "./env.js";
import { IDLE_MS } from "./limits.js";
import { modelFor } from "./model/provider.js";
import { apiReader } from "./tools.js";
import { runTurn } from "./turn.js";
import type { Folded } from "./turn.js";

// One conversation (ADR 0009): the live session, one Durable Object per conversation, named by its id. It is
// reached only over RPC from this Worker's fetch handler, after the service token and the binding are checked:
// it has no `onRequest`, so a request that reaches it any other way gets the Lifecycle's 404. Its storage is a
// working copy of sample data only, deleted when idle; the session lent for a turn lives in memory only.

const FORGET = "forget";
const SSE_HEARTBEAT_MS = 15_000;
/** The words a failed stream carries to the browser: fixed, so nothing from the failure leaks out. */
const FAILED = "failed";

type TurnRow = { id: string; said: string; state: string; text: string; blocks: string; notice: string | null };
type ProposalRow = { turn: string; body: string; state: string };

const refuse = (status: number, error: Refusal | "no_conversation" | "not_your_conversation" | "not_found") =>
  Response.json({ error }, { status });

export class Conversation extends DurableObject<Env> {
  readonly streams = new Streams({ maxChunkBytes: 64 * 1024 });
  readonly lifecycle = Lifecycle.install<Env>(this).use(this.streams);
  /** The turn this instance is running, if any. Only one runs at a time. */
  #running: string | null = null;
  #swept = false;

  onStart(): void {
    const sql = this.ctx.storage.sql;
    // Ids only, no session: whom this conversation belongs to, set by its first turn and never changed.
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_binding (
      only INTEGER PRIMARY KEY CHECK (only = 1), tenant TEXT NOT NULL, person TEXT NOT NULL, company TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_turns (
      n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, said TEXT NOT NULL, state TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', blocks TEXT NOT NULL DEFAULT '[]', notice TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_proposals (
      id TEXT PRIMARY KEY, turn TEXT NOT NULL, n INTEGER NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL)`);
  }

  /** Starts the Lifecycle, which RPC does not do by itself, and ends a turn this instance can no longer run. */
  async #ready(): Promise<void> {
    await this.lifecycle.start();
    if (this.#swept) return;
    this.#swept = true;
    // A turn still live from an earlier instance cannot finish: its session went with that instance.
    for (const { id } of this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM assistant_turns WHERE state = 'live'",
    )) {
      const status = await this.streams.status(id);
      const end = () => this.#fold(id, { text: "", blocks: [], proposals: [], notice: "failed" }, "failed");
      if (status?.state === "streaming") (await this.streams.open(id)).error(FAILED, { commit: end });
      else end();
    }
  }

  /**
   * Refuses a binding for another conversation, person, organisation or company. The first turn binds an unbound
   * conversation; anything else on one answers that it does not exist.
   */
  #check(binding: Binding): Response | "unbound" | null {
    if (binding.conversation !== this.lifecycle.name) return refuse(403, "not_your_conversation");
    const bound = this.ctx.storage.sql
      .exec<{
        tenant: string;
        person: string;
        company: string | null;
      }>("SELECT tenant, person, company FROM assistant_binding")
      .toArray()[0];
    if (bound === undefined) return "unbound";
    const same =
      bound.tenant === binding.tenant && bound.person === binding.person && bound.company === binding.company;
    return same ? null : refuse(403, "not_your_conversation");
  }

  /** Starts a turn and answers with its stream. `session` is the person's, for this turn's reads only. */
  async turn(binding: Binding, said: string, session: string): Promise<Response> {
    await this.#ready();
    const checked = this.#check(binding);
    if (checked instanceof Response) return checked;
    if ([...said.trim()].length > MAX_SAID) return refuse(413, "too_long");
    const words = Said.safeParse(said);
    if (!words.success) return Response.json({ error: "invalid_message" }, { status: 400 });
    const model = modelFor(this.env);
    if (model === null) return refuse(503, "model_unavailable");
    if (this.#running !== null) return refuse(409, "busy");
    const { n } = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM assistant_turns").one();
    if (n >= MAX_TURNS) return refuse(409, "turn_limit");
    if (!(await this.env.PERSON_TURNS.getByName(`${binding.tenant}:${binding.person}`).take())) {
      return refuse(429, "rate_limited");
    }
    // Another turn may have started, or bound the conversation to someone, while the rate was checked.
    const again = this.#check(binding);
    if (again instanceof Response) return again;
    if (this.#running !== null) return refuse(409, "busy");

    const id = `t_${crypto.randomUUID().replaceAll("-", "")}`;
    this.#running = id;
    let writer: StreamWriter;
    try {
      if (again === "unbound") {
        this.ctx.storage.sql.exec(
          "INSERT INTO assistant_binding (only, tenant, person, company) VALUES (1, ?, ?, ?)",
          binding.tenant,
          binding.person,
          binding.company,
        );
      }
      this.ctx.storage.sql.exec("INSERT INTO assistant_turns (id, said, state) VALUES (?, ?, 'live')", id, words.data);
      writer = await this.streams.open(id);
      writer.append({ v: WIRE_VERSION, type: "turn", turn: id, said: words.data });
    } catch (failure) {
      // The turn never started, so the conversation must not stay busy with it.
      this.#running = null;
      throw failure;
    }
    this.ctx.waitUntil(this.#run(binding, id, words.data, session, model, writer));
    await this.#touch();
    return sseResponse(this.streams, id, { from: 0, heartbeatMs: SSE_HEARTBEAT_MS });
  }

  async #run(
    binding: Binding,
    id: string,
    said: string,
    session: string,
    model: LanguageModel,
    writer: StreamWriter,
  ): Promise<void> {
    const out: Folded = { text: "", blocks: [], proposals: [], notice: null };
    try {
      await runTurn({
        model,
        binding,
        said,
        history: this.#history(id),
        read: apiReader(this.env.API, session),
        // A checked event is plain JSON; its type only lacks the index signature Streams asks for.
        emit: (event) => writer.append(event as unknown as StreamJson),
        out,
      });
      writer.close({ commit: () => this.#fold(id, out, "done") });
    } catch {
      // Ids only: never the message, the reply or the error, which may carry either.
      console.warn(JSON.stringify({ event: "assistant_turn_failed", conversation: binding.conversation, turn: id }));
      try {
        if (out.notice === null) {
          out.notice = "failed";
          writer.append({ v: WIRE_VERSION, type: "notice", notice: "failed" });
        }
        writer.error(FAILED, { commit: () => this.#fold(id, out, "failed") });
      } catch {
        // The stream stays live; the next instance ends it (`#ready`). Nothing about it reaches a log.
      }
    } finally {
      this.#running = null;
    }
  }

  /** Earlier finished turns, as the model saw them: what the person said and the reply's text. */
  #history(current: string): Array<ModelMessage> {
    return this.ctx.storage.sql
      .exec<TurnRow>("SELECT id, said, text FROM assistant_turns WHERE state = 'done' AND id != ? ORDER BY n", current)
      .toArray()
      .flatMap(
        (t): Array<ModelMessage> => [
          { role: "user", content: t.said },
          ...(t.text ? [{ role: "assistant" as const, content: t.text }] : []),
        ],
      );
  }

  /** Writes a finished turn and its proposals, which wait on the person. Synchronous: it runs inside the settle. */
  #fold(id: string, out: Folded, state: "done" | "failed"): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "UPDATE assistant_turns SET state = ?, text = ?, blocks = ?, notice = ? WHERE id = ?",
      state,
      out.text,
      JSON.stringify(out.blocks),
      out.notice satisfies Notice | null,
      id,
    );
    out.proposals.forEach((proposal, n) => {
      sql.exec(
        "INSERT INTO assistant_proposals (id, turn, n, body, state) VALUES (?, ?, ?, ?, 'waiting')",
        proposal.id,
        id,
        n,
        JSON.stringify(proposal),
      );
    });
  }

  /** The conversation so far: each turn folded, and the live one, which the screen then follows on its stream. */
  async view(binding: Binding): Promise<Response> {
    await this.#ready();
    const checked = this.#check(binding);
    if (checked instanceof Response) return checked;
    if (checked === "unbound") return refuse(404, "no_conversation");
    const sql = this.ctx.storage.sql;
    const proposals = sql.exec<ProposalRow>("SELECT turn, body, state FROM assistant_proposals ORDER BY n").toArray();
    const turns = sql
      .exec<TurnRow>("SELECT id, said, state, text, blocks, notice FROM assistant_turns ORDER BY n")
      .toArray()
      .map((t) => ({
        id: t.id,
        said: t.said,
        state: t.state,
        text: t.text,
        blocks: JSON.parse(t.blocks) as Array<unknown>,
        proposals: proposals
          .filter((p) => p.turn === t.id)
          .map((p) => ({ proposal: JSON.parse(p.body) as unknown, state: p.state })),
        notice: t.notice,
      }));
    return Response.json({ v: WIRE_VERSION, turns });
  }

  /** A turn's stream from `from`: a dropped connection resumes where it stopped; a second tab starts at 0. */
  async events(binding: Binding, turn: string, from: number): Promise<Response> {
    await this.#ready();
    const checked = this.#check(binding);
    if (checked instanceof Response) return checked;
    if (checked === "unbound") return refuse(404, "no_conversation");
    const known = this.ctx.storage.sql.exec("SELECT 1 FROM assistant_turns WHERE id = ?", turn).toArray().length;
    if (known === 0) return refuse(404, "not_found");
    return sseResponse(this.streams, turn, { from, heartbeatMs: SSE_HEARTBEAT_MS });
  }

  /**
   * Records the person's answer to a waiting proposal, which the web has already acted on (or not) with the API.
   * Nothing runs here: this only stops the proposal waiting.
   */
  async settle(binding: Binding, proposal: string, outcome: "confirmed" | "dismissed"): Promise<Response> {
    await this.#ready();
    const checked = this.#check(binding);
    if (checked instanceof Response) return checked;
    if (checked === "unbound") return refuse(404, "no_conversation");
    const changed = this.ctx.storage.sql.exec(
      "UPDATE assistant_proposals SET state = ? WHERE id = ? AND state = 'waiting'",
      outcome,
      proposal,
    ).rowsWritten;
    if (changed === 0) return refuse(404, "not_found");
    await this.#touch();
    return new Response(null, { status: 204 });
  }

  /** Puts off the idle deletion: the working copy goes once the conversation has been idle for `IDLE_MS`. */
  async #touch(): Promise<void> {
    await this.lifecycle.jobs.push({ id: FORGET, fn: FORGET, time: Date.now() + IDLE_MS });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== FORGET) return;
    if (this.#running !== null) return { rescheduleAt: Date.now() + IDLE_MS };
    // The Lifecycle's own teardown, then the storage; the next request starts a fresh, empty instance.
    await this.lifecycle.disableAlarms();
    await this.lifecycle.dispose();
    await this.ctx.storage.deleteAll();
    // As the SDK's own `Agent.destroy()` does: reset the instance once this alarm has returned, without a retry.
    setTimeout(() => {
      try {
        (this.ctx.abort as (reason: string, options: { retryAlarm: boolean }) => void)("forgotten", {
          retryAlarm: false,
        });
      } catch {
        // The reset is under way; the throw only reports it.
      }
    }, 0);
  }
}
