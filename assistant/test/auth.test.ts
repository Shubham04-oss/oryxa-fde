import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { authorized, verifyBinding } from "../src/auth.js";
import { parseRoute } from "../src/index.js";
import { SESSION } from "./fake-api.js";
import { KEY, PERSON, SERVICE, TENANT, bindingFor, call, freshConversation, say, sign } from "./helpers.js";

const now = () => Math.floor(Date.now() / 1000);

describe("only fde-web reaches the Worker", () => {
  it("refuses every route without the service token, or with a wrong one", async () => {
    const c = freshConversation();
    for (const [path, method] of [
      [`/internal/v1/conversations/${c}`, "GET"],
      [`/internal/v1/conversations/${c}/turns`, "POST"],
      [`/internal/v1/conversations/${c}/turns/t_1/events`, "GET"],
      [`/internal/v1/conversations/${c}/proposals/p_1`, "POST"],
    ] as const) {
      for (const token of [null, "", `${SERVICE}x`, KEY]) {
        const response = await call(path, { method, token, session: SESSION, body: { text: "hi" } });
        expect(response.status, `${method} ${path} with ${String(token)}`).toBe(401);
      }
    }
  });

  it("fails closed when its configured service token is unset or short", async () => {
    const request = new Request("https://assistant.internal/", { headers: { authorization: "Bearer short" } });
    expect(await authorized(request, undefined)).toBe(false);
    expect(await authorized(request, "short")).toBe(false);
  });

  it("does not expose the Agents SDK's default routing by name", async () => {
    const c = freshConversation();
    for (const path of [`/agents/conversation/${c}`, `/agents/conversations/${c}`, `/agents/Conversation/${c}/x`]) {
      const response = await exports.default.fetch(
        new Request(`https://assistant.internal${path}`, { headers: { authorization: `Bearer ${SERVICE}` } }),
      );
      expect(response.status, path).toBe(404);
    }
    // And the object answers no HTTP of its own: it is reached over RPC only.
    const direct = await env.CONVERSATIONS.getByName(c).fetch(`https://assistant.internal/agents/conversation/${c}`);
    expect(direct.status).toBe(404);
  });

  it("parses only its own routes, with the platform's id rule", () => {
    expect(parseRoute("GET", "/internal/v1/conversations/c_1")).toEqual({ action: "view", conversation: "c_1" });
    expect(parseRoute("POST", "/internal/v1/conversations/c_1/turns")).toEqual({ action: "turn", conversation: "c_1" });
    expect(parseRoute("GET", "/internal/v1/conversations/c_1/turns")).toBe("method");
    for (const path of [
      "/internal/v1/conversations/c%2F1",
      "/internal/v1/conversations/c:1",
      "/internal/v1/conversations/c_1/turns/t_1/x",
      "/internal/v2/conversations/c_1",
      "/internal/v1/conversations/c_1/proposals/p%2F1",
    ]) {
      expect(parseRoute("GET", path), path).toBeNull();
    }
  });
});

describe("the binding", () => {
  it("is refused when missing, unsigned, signed with another key, expired or too long-lived", async () => {
    const c = freshConversation();
    const claims = { v: 1, conv: c, tenant: TENANT, person: PERSON, company: null };
    const valid = await sign({ ...claims, exp: now() + 60 });
    const [payload] = valid.split(".");
    for (const [name, binding] of [
      ["missing", null],
      ["unsigned", payload!],
      ["another key", await sign({ ...claims, exp: now() + 60 }, `${KEY}-other`)],
      ["expired", await sign({ ...claims, exp: now() - 1 })],
      ["too long-lived", await sign({ ...claims, exp: now() + 3600 })],
      ["another version", await sign({ ...claims, v: 2, exp: now() + 60 })],
      [
        "a tampered payload",
        `${btoa(JSON.stringify({ ...claims, person: "user_x", exp: now() + 60 }))}.${valid.split(".")[1]}`,
      ],
    ] as const) {
      const { response } = await say(c, "hello", SESSION, binding as string);
      expect(response.status, name).toBe(403);
    }
    expect((await say(c, "hello", SESSION, valid)).response.status).toBe(200);
  });

  it("is refused for another conversation than the one addressed", async () => {
    const mine = freshConversation();
    const other = freshConversation();
    const { response } = await say(mine, "hello", SESSION, await bindingFor(other));
    expect(response.status).toBe(403);
  });

  it("checks ids before they reach a name or SQL", async () => {
    const c = freshConversation();
    for (const bad of [{ person: "user:x" }, { tenant: "" }, { company: "cmp/1" }, { conv: `${c}/x` }]) {
      expect(await verifyBinding(await bindingFor(c, bad), KEY, c), JSON.stringify(bad)).toBeNull();
    }
  });

  it("binds a conversation to its first person, organisation and company, and refuses any other", async () => {
    const c = freshConversation();
    expect((await say(c, "hello")).response.status).toBe(200);
    for (const other of [{ person: "user_b" }, { tenant: "org_b" }, { company: "cmp_kestrel" }]) {
      const binding = await bindingFor(c, other);
      const turn = await say(c, "hello", SESSION, binding);
      expect(turn.response.status, JSON.stringify(other)).toBe(403);
      expect(await turn.response.json()).toEqual({ error: "not_your_conversation" });
      const view = await call(`/internal/v1/conversations/${c}`, { binding });
      expect(view.status).toBe(403);
      const events = await call(`/internal/v1/conversations/${c}/turns/t_x/events`, { binding });
      expect(events.status).toBe(403);
      const settle = await call(`/internal/v1/conversations/${c}/proposals/p_x`, {
        method: "POST",
        binding,
        body: { outcome: "confirmed" },
      });
      expect(settle.status).toBe(403);
    }
  });

  it("is checked on every reconnect, not only when the turn starts", async () => {
    const c = freshConversation();
    const { events } = await say(c, "hello");
    const turn = (events[0] as { turn: string }).turn;
    const path = `/internal/v1/conversations/${c}/turns/${turn}/events`;
    expect((await call(path)).status).toBe(200);
    expect(
      (
        await call(path, {
          binding: await sign({ v: 1, conv: c, tenant: TENANT, person: PERSON, company: null, exp: now() - 5 }),
        })
      ).status,
    ).toBe(403);
    expect((await call(path, { binding: await bindingFor(c, { person: "user_b" }) })).status).toBe(403);
  });

  it("needs the person's session on a turn", async () => {
    const c = freshConversation();
    const response = await call(`/internal/v1/conversations/${c}/turns`, { method: "POST", body: { text: "hello" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no_session" });
  });
});

describe("a binding signed by fde-web", () => {
  // The same vector is signed by fde-web's own tests (fde-web/src/assistant.test.ts).
  it("is verified exactly as it is signed", async () => {
    const vector =
      "eyJ2IjoxLCJjb252IjoiY192ZWN0b3IiLCJ0ZW5hbnQiOiJvcmdfc2FtcGxlIiwicGVyc29uIjoidXNlcl9yaXlhIiwiY29tcGFueSI6ImNtcF9rZXN0cmVsIiwiZXhwIjoxNzk0NDc0MDYwfQ.cLwhBRHlOgjFKpTkyKXbFxHf2mqjUrWh7YA5xUHi3gc";
    const key = "sample-vector-key-not-a-secret-0123456789";
    const at = Date.UTC(2026, 10, 12, 9, 0, 0);
    expect(await verifyBinding(vector, key, "c_vector", at)).toEqual({
      conversation: "c_vector",
      tenant: "org_sample",
      person: "user_riya",
      company: "cmp_kestrel",
    });
    // A minute later it has expired.
    expect(await verifyBinding(vector, key, "c_vector", at + 60_000)).toBeNull();
  });
});
