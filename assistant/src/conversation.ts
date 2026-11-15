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
import { readRecord, recordOf, withoutDestinations, writeAnswer, writeTurn } from "./record.js";
import type { Answer, Lent, Written } from "./record.js";
import { apiReader } from "./tools.js";
import { runTurn } from "./turn.js";
import type { Folded } from "./turn.js";

// One conversation (ADR 0009): the live session, one Durable Object per conversation, named by its id. It is
// reached only over RPC from this Worker's fetch handler, after the service token and the binding are checked:
// it has no `onRequest`, so a request that reaches it any other way gets the Lifecycle's 404. Its storage is a
// working copy of sample data only, deleted when idle; the session lent for a turn lives in memory only.
// The record is the API's (issue #279): each finished turn, and each answer to a proposal, is written there with the
// session lent for the call, in the background and in order, and an object that holds nothing is rebuilt from it.

const FORGET = "forget";
const SSE_HEARTBEAT_MS = 15_000;
/** The words a failed stream carries to the browser: fixed, so nothing from the failure leaks out. */
const FAILED = "failed";

type TurnRow = {
  n: number;
  id: string;
  said: string;
  state: string;
  text: string;
  blocks: string;
  notice: string | null;
};
type ProposalRow = { turn: string; body: string; state: string };

type Refused =
  | Refusal
  | "no_conversation"
  | "not_your_conversation"
  | "not_found"
  | "unknown_conversation"
  | "record_unavailable";
const refuse = (status: number, error: Refused) => Response.json({ error }, { status });

/** Ids and an outcome only, never what was said or the session. */
const logRecord = (fields: Record<string, string | number>) =>
  console.warn(JSON.stringify({ event: "assistant_record", ...fields }));

export class Conversation extends DurableObject<Env> {
  readonly streams = new Streams({ maxChunkBytes: 64 * 1024 });
  readonly lifecycle = Lifecycle.install<Env>(this).use(this.streams);
  /** The turn this instance is running, if any. Only one runs at a time. */
  #running: string | null = null;
  /** Stops the running turn when the person asks (`stop`). */
  #stopper: AbortController | null = null;
  #swept = false;
  /** The record's writes, one after another, so turns reach the API in order. */
  #writes: Promise<void> = Promise.resolve();
  /** A rebuild under way, which a second call waits on rather than starting its own. */
  #rebuilding: Promise<"ok" | "gone" | "error"> | null = null;

  onStart(): void {
    const sql = this.ctx.storage.sql;
    // Ids only, no session: whom this conversation belongs to, set by its first turn and never changed.
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_binding (
      only INTEGER PRIMARY KEY CHECK (only = 1), tenant TEXT NOT NULL, person TEXT NOT NULL, company TEXT)`);
    // `n` is the turn's place in the record too; `record` is whether it is written there yet.
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_turns (
      n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, said TEXT NOT NULL, state TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', blocks TEXT NOT NULL DEFAULT '[]', notice TEXT)`);
    // `owed`: the person answered it and the record does not have the answer yet.
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_proposals (
      id TEXT PRIMARY KEY, turn TEXT NOT NULL, n INTEGER NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL)`);
    // Added for the record (issue #279), also to a working copy made before it.
    this.#column("assistant_binding", "full", "INTEGER NOT NULL DEFAULT 0");
    this.#column("assistant_turns", "record", "TEXT NOT NULL DEFAULT 'pending'");
    this.#column("assistant_proposals", "owed", "INTEGER NOT NULL DEFAULT 0");
  }

  #column(table: string, column: string, definition: string): void {
    const sql = this.ctx.storage.sql;
    const has = sql.exec("SELECT 1 FROM pragma_table_info(?) WHERE name = ?", table, column).toArray().length > 0;
    if (!has) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

  /**
   * Starts a turn and answers with its stream. `lent` is the person's session, for this turn's reads and the
   * record's writes only.
   */
  async turn(binding: Binding, said: string, lent: Lent): Promise<Response> {
    await this.#ready();
    const checked = await this.#bound(binding, lent);
    if (checked !== null) return checked;
    if ([...said.trim()].length > MAX_SAID) return refuse(413, "too_long");
    const words = Said.safeParse(said);
    // A lone surrogate cannot be stored in the record, so it is refused like any other malformed message.
    if (!words.success || /\p{Cs}/u.test(words.data)) {
      return Response.json({ error: "invalid_message" }, { status: 400 });
    }
    const model = modelFor(this.env);
    if (model === null) return refuse(503, "model_unavailable");
    if (this.#running !== null) return refuse(409, "busy");
    const { n } = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM assistant_turns").one();
    if (n >= MAX_TURNS || this.#full()) return refuse(409, "turn_limit");
    if (!(await this.env.PERSON_TURNS.getByName(`${binding.tenant}:${binding.person}`).take())) {
      return refuse(429, "rate_limited");
    }
    // Another turn may have started, or the working copy gone idle, while the rate was checked.
    const again = this.#check(binding);
    if (again instanceof Response) return again;
    if (again === "unbound") return refuse(503, "record_unavailable");
    if (this.#running !== null) return refuse(409, "busy");

    const id = `t_${crypto.randomUUID().replaceAll("-", "")}`;
    this.#running = id;
    const stopper = new AbortController();
    this.#stopper = stopper;
    let writer: StreamWriter;
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO assistant_turns (id, said, state, record) VALUES (?, ?, 'live', 'pending')",
        id,
        words.data,
      );
      writer = await this.streams.open(id);
      writer.append({ v: WIRE_VERSION, type: "turn", turn: id, said: words.data });
    } catch (failure) {
      // The turn never started, so the conversation must not stay busy with it.
      this.#running = null;
      this.#stopper = null;
      throw failure;
    }
    // What an earlier turn could not write goes first, in the background: the stream does not wait on it.
    this.#record(binding, lent);
    this.ctx.waitUntil(this.#run(binding, id, words.data, lent, model, writer, stopper.signal));
    await this.#touch();
    return sseResponse(this.streams, id, { from: 0, heartbeatMs: SSE_HEARTBEAT_MS });
  }

  async #run(
    binding: Binding,
    id: string,
    said: string,
    lent: Lent,
    model: LanguageModel,
    writer: StreamWriter,
    stop: AbortSignal,
  ): Promise<void> {
    const out: Folded = { text: "", blocks: [], proposals: [], notice: null };
    try {
      await runTurn({
        model,
        binding,
        said,
        history: this.#history(id),
        read: apiReader(this.env.API, lent.session),
        // A checked event is plain JSON; its type only lacks the index signature Streams asks for.
        emit: (event) => writer.append(event as unknown as StreamJson),
        out,
        stop,
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
      this.#stopper = null;
      // However it ended, the finished turn goes to the record, after anything still waiting to.
      this.#record(binding, lent);
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
  async view(binding: Binding, lent: Lent | null): Promise<Response> {
    await this.#ready();
    const checked = await this.#bound(binding, lent);
    if (checked !== null) return checked;
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
  async settle(binding: Binding, proposal: string, outcome: Answer, lent: Lent | null): Promise<Response> {
    await this.#ready();
    const checked = await this.#bound(binding, lent);
    if (checked !== null) return checked;
    const changed = this.ctx.storage.sql.exec(
      "UPDATE assistant_proposals SET state = ?, owed = 1 WHERE id = ? AND state = 'waiting'",
      outcome,
      proposal,
    ).rowsWritten;
    if (changed === 0) return refuse(404, "not_found");
    // Recorded in the background; without a session now, at the next turn.
    if (lent !== null) this.#record(binding, lent);
    await this.#touch();
    return new Response(null, { status: 204 });
  }

  /**
   * Refuses a binding `#check` refuses. An object that holds nothing yet is rebuilt from the API's record first, with
   * the session lent for this call; without one it answers that the conversation has nothing in it yet.
   */
  async #bound(binding: Binding, lent: Lent | null): Promise<Response | null> {
    const checked = this.#check(binding);
    if (checked !== "unbound") return checked;
    if (lent === null) return refuse(404, "no_conversation");
    this.#rebuilding ??= this.#rebuild(binding, lent.session).finally(() => {
      this.#rebuilding = null;
    });
    const rebuilt = await this.#rebuilding;
    if (rebuilt === "gone") return refuse(404, "unknown_conversation");
    if (rebuilt === "error") return refuse(503, "record_unavailable");
    const again = this.#check(binding);
    return again === "unbound" ? refuse(503, "record_unavailable") : again;
  }

  /**
   * Fills an empty working copy from the record, which the API keeps for the person fde-web checked on this call:
   * the binding, then each turn at its place with its proposals as the person left them. Nothing is written back.
   * Without an API binding there is no record, and it starts empty.
   */
  async #rebuild(binding: Binding, session: string): Promise<"ok" | "gone" | "error"> {
    const record = this.env.API === undefined ? { turns: [] } : await readRecord(this.env.API, session, binding);
    if (record === "gone" || record === "error") return record;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      if (this.#check(binding) !== "unbound") return;
      sql.exec(
        "INSERT INTO assistant_binding (only, tenant, person, company) VALUES (1, ?, ?, ?)",
        binding.tenant,
        binding.person,
        binding.company,
      );
      for (const t of record.turns) {
        sql.exec(
          `INSERT INTO assistant_turns (n, id, said, state, text, blocks, notice, record)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'written')`,
          t.n,
          t.id,
          t.said,
          t.state,
          t.text,
          JSON.stringify(t.blocks),
          t.notice,
        );
        t.proposals.forEach(({ proposal, state }, i) => {
          sql.exec(
            "INSERT OR IGNORE INTO assistant_proposals (id, turn, n, body, state) VALUES (?, ?, ?, ?, ?)",
            proposal.id,
            t.id,
            i,
            JSON.stringify(proposal),
            state,
          );
        });
      }
    });
    return "ok";
  }

  /** Whether the record has refused a turn for the conversation being full. */
  #full(): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM assistant_binding WHERE full = 1").toArray().length > 0;
  }

  /** Queues a write of whatever the record does not have yet, with `lent`, after any write already queued. */
  #record(binding: Binding, lent: Lent): void {
    const next = this.#writes
      .then(() => this.#flush(binding, lent))
      .catch(() => {
        // Ids only: never the error, which may carry the turn or the session.
        logRecord({ conversation: binding.conversation, outcome: "failed" });
      });
    this.#writes = next;
    this.ctx.waitUntil(next);
  }

  /**
   * Writes each finished turn the record does not have, in order, then each answer it does not have. It stops at the
   * first that has to wait (no answer, or no longer this session's to write), so a later turn never lands first; what
   * is left is written with the next session lent. A turn the API refuses is marked so and not tried again.
   */
  async #flush(binding: Binding, lent: Lent): Promise<void> {
    const api = this.env.API;
    if (api === undefined) return;
    const sql = this.ctx.storage.sql;
    const { conversation } = binding;
    const pending = sql
      .exec<TurnRow>(
        `SELECT n, id, said, state, text, blocks, notice FROM assistant_turns
         WHERE record = 'pending' AND state != 'live' ORDER BY n`,
      )
      .toArray();
    for (const t of pending) {
      const proposals = sql
        .exec<{ body: string }>("SELECT body FROM assistant_proposals WHERE turn = ? ORDER BY n", t.id)
        .toArray()
        .map((p) => JSON.parse(p.body) as unknown);
      const blocks = JSON.parse(t.blocks) as Array<unknown>;
      const record = recordOf({ ...t, blocks, proposals }, binding.company === null);
      let outcome: Written = "refused";
      if (record !== null) {
        outcome = await writeTurn(api, lent, conversation, t.n, record);
        // A record the API refuses to name (not the person's to see, or not there): kept without what names it.
        if (outcome === "destination")
          outcome = await writeTurn(api, lent, conversation, t.n, withoutDestinations(record));
      }
      if (outcome !== "written") logRecord({ conversation, turn: t.id, n: t.n, outcome });
      if (outcome === "later") return;
      sql.exec(
        "UPDATE assistant_turns SET record = ? WHERE id = ?",
        outcome === "written" ? "written" : "refused",
        t.id,
      );
      if (outcome === "full") sql.exec("UPDATE assistant_binding SET full = 1");
    }
    const owed = sql
      .exec<{ id: string; state: Answer; n: number }>(
        `SELECT p.id, p.state, t.n FROM assistant_proposals p JOIN assistant_turns t ON t.id = p.turn
         WHERE p.owed = 1 AND t.record = 'written' ORDER BY t.n, p.n`,
      )
      .toArray();
    for (const p of owed) {
      const outcome = await writeAnswer(api, lent, conversation, p.n, p.id, p.state);
      if (outcome !== "recorded") logRecord({ conversation, proposal: p.id, n: p.n, outcome });
      if (outcome === "later") return;
      sql.exec("UPDATE assistant_proposals SET owed = 0 WHERE id = ?", p.id);
    }
  }

  /**
   * Stops `turn` if it is the one running, for the person who holds the conversation: it ends with the `stopped`
   * notice, keeping what it had said. Anyone else is refused alike whether the conversation exists or not, and a
   * turn that is not running (finished, unknown, or another's id) is a no-op, so the answer tells nothing more.
   */
  async stop(binding: Binding, turn: string): Promise<Response> {
    await this.#ready();
    if (this.#check(binding) !== null) return refuse(403, "not_your_conversation");
    if (this.#running === turn) this.#stopper?.abort();
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
