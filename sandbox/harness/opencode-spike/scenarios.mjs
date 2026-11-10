// Canned model turns. A scenario is chosen by a `[scenario:<name>]` marker in the prompt; step N answers the Nth model
// request of the agent loop (N counts the assistant messages so far). Tool and argument names are OpenCode 2.2.7's,
// as the stub saw them in the request's `tools` list.
const SERVER = "/workspace/repo/src/server.mjs";
const TEST = "/workspace/repo/test/healthz.test.mjs";
const todos = (...states) => ({
  name: "todowrite",
  args: {
    todos: [
      { content: "Add a /healthz route", status: states[0] },
      { content: "Add a test for /healthz", status: states[1] },
    ],
  },
});

export const scenarios = {
  hello: (turn) => (turn === 0 ? { text: "Hello from the stub model." } : { text: "Done." }),

  // The session recorded as the fixture: plan, read, edit, add a test, a failing shell run, a fix, a passing run.
  healthz: (turn) =>
    [
      {
        text: "I'll add a /healthz route and a test for it.",
        toolCalls: [todos("in_progress", "pending"), { name: "read", args: { path: SERVER } }],
      },
      {
        toolCalls: [
          {
            name: "edit",
            args: {
              path: SERVER,
              oldString: '  if (path === "/") return',
              newString: '  if (path === "/healthz") return { status: 200, body: "ok" };\n  if (path === "/") return',
            },
          },
        ],
      },
      {
        toolCalls: [
          todos("completed", "in_progress"),
          {
            name: "write",
            args: {
              path: TEST,
              content:
                'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { handle } from "../src/server.mjs";\n\ntest("healthz", () => {\n  assert.deepEqual(handle("/healthz"), { status: 200, body: "ok\\n" });\n});\n',
            },
          },
        ],
      },
      { toolCalls: [{ name: "shell", args: { command: "npm test", workdir: "/workspace/repo" } }] },
      {
        toolCalls: [{ name: "edit", args: { path: TEST, oldString: 'body: "ok\\n"', newString: 'body: "ok"' } }],
      },
      { toolCalls: [{ name: "shell", args: { command: "npm test", workdir: "/workspace/repo" } }] },
      { toolCalls: [todos("completed", "completed")] },
      { text: 'Added GET /healthz returning "ok", with a test. The tests pass.' },
    ][turn] ?? { text: "Done." },

  // Read-only tools under a base policy of ask: does each one raise a permission request?
  readonly: (turn) =>
    [
      {
        toolCalls: [
          { name: "read", args: { path: SERVER } },
          { name: "glob", args: { pattern: "**/*.mjs", path: "/workspace/repo" } },
          { name: "grep", args: { pattern: "handle", path: "/workspace/repo" } },
        ],
      },
      { text: "Read-only tools done." },
    ][turn] ?? { text: "Done." },

  // The tools a headless run must never use. Each is called once; all should be denied by config.
  forbidden: (turn) =>
    [
      {
        toolCalls: [
          {
            name: "question",
            args: {
              questions: [
                { question: "Which colour?", header: "Colour", options: [{ label: "red", description: "red" }] },
              ],
            },
          },
          { name: "subagent", args: { agent: "general", description: "spike", prompt: "say hi" } },
          { name: "skill", args: { id: "anything" } },
          { name: "websearch", args: { query: "opencode acp" } },
          { name: "webfetch", args: { url: "http://example.com/spike" } },
          { name: "execute", args: { code: "return 1 + 1" } },
        ],
      },
      { text: "Forbidden tools done." },
    ][turn] ?? { text: "Done." },
};

// A shell command that outlasts the observation window, so sockets can be listed while a prompt is running.
scenarios.slowshell = (turn) =>
  [{ toolCalls: [{ name: "shell", args: { command: "sleep 12", workdir: "/workspace/repo" } }] }, { text: "Slept." }][
    turn
  ] ?? {
    text: "Done.",
  };

// OpenCode's own management tools, which appear as direct tools when Code Mode's `execute` is denied.
scenarios.internal = (turn) =>
  [
    {
      toolCalls: [
        { name: "opencode_models", args: { query: "stub" } },
        { name: "opencode_worktree_create", args: { name: "spike-wt" } },
        { name: "opencode_session_move", args: { directory: "/tmp" } },
        { name: "opencode_read_mcp_resource", args: { server: "x", uri: "file:///x" } },
        { name: "skill", args: { id: "anything" } },
      ],
    },
    { text: "Internal tools done." },
  ][turn] ?? { text: "Done." };

scenarios["worktree-remove"] = (turn) =>
  [{ toolCalls: [{ name: "opencode_worktree_remove", args: { directory: "/tmp/spike-wt" } }] }, { text: "Done." }][
    turn
  ] ?? {
    text: "Done.",
  };

// The same harmless command three times in one session: does an answer of "once" stop the next request?
scenarios.again = (turn) =>
  [
    { toolCalls: [{ name: "shell", args: { command: "echo sample-one", workdir: "/workspace/repo" } }] },
    { toolCalls: [{ name: "shell", args: { command: "echo sample-one", workdir: "/workspace/repo" } }] },
    { toolCalls: [{ name: "shell", args: { command: "echo sample-two", workdir: "/workspace/repo" } }] },
    { text: "Done." },
  ][turn] ?? { text: "Done." };

// A forger starts in the background under the first (approved) shell call; the second call, a file write, is never
// answered by the client, so it can only proceed if the forged answer is accepted.
for (const mode of ["http", "stdin"]) {
  scenarios[`forge-${mode}`] = (turn) =>
    [
      {
        toolCalls: [
          {
            name: "shell",
            args: {
              command: `nohup node /spike/forge.mjs ${mode} /scratch/forge-${mode}.txt >/dev/null 2>&1 &`,
              workdir: "/workspace/repo",
            },
          },
        ],
      },
      {
        toolCalls: [
          { name: "write", args: { path: `/workspace/repo/FORGED-${mode}.txt`, content: "invented sample\n" } },
        ],
      },
      { text: "Done." },
    ][turn] ?? { text: "Done." };
}

// A command that would run for a minute, to see what a cancel does to the process it started.
scenarios.longshell = (turn) =>
  [{ toolCalls: [{ name: "shell", args: { command: "sleep 61", workdir: "/workspace/repo" } }] }, { text: "Slept." }][
    turn
  ] ?? {
    text: "Done.",
  };

// Three model steps with cache and reasoning counts in each step's usage, to see how ACP reports them.
scenarios["usage-detail"] = (turn) =>
  [
    { toolCalls: [{ name: "read", args: { path: SERVER } }] },
    { toolCalls: [{ name: "grep", args: { pattern: "handle", path: "/workspace/repo" } }] },
    { text: "Three steps done." },
  ][turn] ?? { text: "Done." };
