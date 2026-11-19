# 0013: Personal workspaces, modules, rules and the plugin runner

Status: accepted, for a later phase. **Do not build any of it until `docs/plan.md` schedules it;**
until then it is design only, and no issue may cite it as a reason to add a table, route, service or
screen. The first half (blocks, record types, rules, modules, workspaces, job profiles) is phase 4 in
`docs/roadmap.md`; the plugin runner is phase 5. Depends on ADR 0010 (organisations, roles), ADR 0011
(types, inputs, resolution, the cost ledger) and ADR 0012 (assets, bindings, runs). Amends ADR 0008
and `docs/direction.md` section 9: the rule that the workspace "never writes markup or code for a
screen" stays for screens; code for logic is now allowed, under the rules below.

## Context
FDEs do not work alike, and an agency's builders and its deployment leads do not either. A fixed set
of screens fits nobody well, and a screen per request does not scale. The founder wants each person
to arrange their own workspace from our pieces, to add their own record types and rules, and, where
our pieces are not enough, to have an assistant write the logic for them. Code written by a model, at
a person's request, running against an organisation's data, is a new way for things to go wrong, so
the rules for it are set here before any of it is built.

## Decision

### The pieces

| Piece | What it is |
| --- | --- |
| **Block** | A UI element from a fixed catalogue the web owns: list, table, checklist, agenda or calendar, kanban, timeline, metric, chart, form, note, conversation. Each has a schema, as in ADR 0008. |
| **Record type** | A kind of record: ours (task, decision and so on), filled by a connector (ADR 0012), or a person's own, declared with the type system of ADR 0011. |
| **Rule** | When an event, a schedule or a condition; if typed conditions hold; then one action from a fixed list. |
| **Module** | Blocks bound to record queries, plus rules, plus declared inputs. A module is an asset (ADR 0012): versioned, forkable, bound at a node. |
| **Workspace** | One person's arrangement of modules into pages. |
| **Job profile** | An organisation's starting layout for a kind of job (Builder, Deployment lead). |

- **Our own features are modules in the same format.** Today, the board and the engagement page are
  modules we ship as platform assets. If the format cannot express one of ours, the format is
  extended; ours get no private path.
- **A job profile is a starting point, not a permission.** It sets which modules a new person's
  workspace starts with. What they may read or change is their roles (ADR 0010), whatever their
  profile.

### A person's own layer
- **Private by default.** A person's modules, their own record types and their personal connections
  (their calendar, their own mail) are theirs. They are stored as the organisation's data, under
  row-level security that also checks the owner.
- **An organisation's admins cannot read a person's personal connection data,** nor the records it
  fills. They can see that a personal connection exists, its type and its hosts, and can remove it or
  forbid the type by policy.
- **Sharing makes an asset.** A person who shares a module, record type or rule to a team or the
  organisation publishes it as an asset (ADR 0012) with `shared` visibility; the shared version holds
  definitions only, never the person's records.

### Rules
- **Actions come from a fixed list,** each an ordinary API route with its own checks, run with the
  permissions of the person who owns the rule.
- **A rule's action cannot trigger another rule.** Events caused by a rule's action are marked and do
  not match rules, so rules cannot loop.
- **Every rule is rate-limited and has a cost cap** per run and per day. Hitting either stops the rule
  and tells its owner.

### Custom code: plugins
- **Code for logic, our blocks for the screen.** A plugin computes, transforms, fetches and decides.
  Anything it shows is a block description that the web app validates and renders, as in ADR 0008.
  No plugin code runs in the browser. Custom UI in a sandboxed iframe on a separate origin is deferred.
- **A plugin is a manifest and a WebAssembly component.** The manifest declares typed inputs (ADR
  0011), the record types it reads and writes, the hosts it may call, its triggers, and the host
  functions it imports. It is shown to the person in plain words when they install it.
- **The host interface is defined once in WIT,** generated from the type system, so a plugin sees the
  same types as everything else. TypeScript is the default language to write one in; any language
  that builds a component works.
- **Plugins are assets** (ADR 0012): versioned, hashed, forkable, bound at a node, and run as runs.

### The plugin runner
- **A separate service,** in Rust on wasmtime, with its own task role. It holds no secrets and no
  database login; it reaches data only through the API with the person's authority for that run.
- **No ambient capability.** No filesystem, no network, no clock beyond what the host gives, no
  secrets. Outbound HTTP goes only through a host function that checks the manifest's hosts against
  the organisation's allowlist and adds credentials itself, the model the sandbox's outbound handler
  used before the reset (ADR 0004).
- **Limits on every run:** a fuel or epoch limit on CPU, a memory cap, a wall-clock timeout, a cap on
  host calls, and a model cost cap. Any limit reached ends the run as failed.
- **Every host call runs with the person's permissions,** checked through `oryxa-authz`, inside the
  run's organisation and node.
- **Writes:** a write to the person's own private records is applied. A write to anything shared
  comes back as a proposed action, which the person confirms (ADR 0008) unless an organisation policy
  pre-approves that action for that plugin.
- **Every run is recorded** as a run (ADR 0012), in the audit log, and in the cost ledger (ADR 0011).
- **Fail closed.** A manifest that does not match the component's imports, a host call that errors,
  an authz error or a limit reached stops the run. Nothing is retried with wider rights.

### How a plugin is made
1. The assistant writes the manifest and the code at the person's request.
2. An isolated build step, never the API, compiles it to a component.
3. Checks: the manifest's permissions against the host functions the component actually imports;
   the plugin's own tests; a second-opinion review of the code.
4. A preview shows what it does and what it is allowed to do.
5. The person installs it.

- **A personal plugin installs within organisation policy.** Sharing it to the organisation needs an
  admin's review.
- **Organisation policy decides** whether custom code is allowed at all, and which host functions a
  plugin may import.

### The same runner, later
- Connector adapters, ETL transform steps and eval graders become components run the same way, so
  the limits, permissions and records above apply to them too.
- Heavy jobs (native libraries, long runs, a coding agent) stay in container sandboxes (ADR 0003,
  ADR 0004).

## Consequences
- The web owns the block catalogue and renders block descriptions from any source, ours or a plugin's,
  through one validator.
- The runner is a new service with its own deploy, task role and limits, and the build step is
  another. Neither holds secrets.
- A plugin can still waste a person's attention or money within its caps. It cannot read beyond the
  person's permissions, reach an unlisted host, or change shared data without a confirmation or a
  policy that allows it.
- Personal connection data is a new kind of privacy boundary inside an organisation, so the isolation
  suite (ADR 0010) gains cases for an admin reading another person's private layer.

## Open questions

| Question | Default |
| --- | --- |
| Who reviews a plugin shared to the organisation? | Someone with `manage` at the root node. |
| May a rule's action start a plugin? | Yes, under the same rule caps and the plugin's own limits. |
