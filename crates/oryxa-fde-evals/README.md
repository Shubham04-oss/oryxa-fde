# oryxa-fde-evals

Eval suites for a project, linked to its success criteria, run in the company's sandbox. Each criterion gets a
pass rate the customer can see. The HTTP API is mounted with the agent run API (`crates/oryxa-fde-agent`,
`openapi.evals.json`), which gives the runner the company's sandbox and the model.

## A suite

- **Criteria.** The project's success criteria it measures; each must exist on the project. A case can name a
  subset; otherwise it measures all of them.
- **Target** (optional). A command run in the sandbox for each case, with `EVAL_CASE` and `EVAL_INPUT` in its
  environment; its stdout is the output. Without a target, a run grades outputs imported as CSV.
- **Graders**, applied to every case in order. A case passes only if every grader passes it.

| Grader | Passes when |
| --- | --- |
| `exact_match` | The output equals `expected`, ignoring surrounding whitespace (and case, with `ignore_case`). |
| `regex` | The output matches the pattern (at most 512 bytes; compiled with a size limit). |
| `json_schema` | The output is JSON valid against the schema. Only a strict subset of JSON Schema is accepted (`schema.rs`): a suite using any other keyword is refused, never half-enforced. |
| `script` | A command in the sandbox exits 0, given `EVAL_CASE`, `EVAL_INPUT`, `EVAL_EXPECTED` and `EVAL_OUTPUT`. |
| `judge` | A model grades the output against a rubric. The case is fenced as data in the prompt, and only a JSON verdict is read back. |

A grader that cannot decide (a sandbox or model failure, a case without `expected` for `exact_match`) gives
`errored`, never a pass. An errored case counts against its criteria's pass rates, and as failed in
`eval_run.finished`.

## CSV

- **Cases:** `input`, and optionally `expected`, `id` and `criteria` (ids separated by `;`).
- **Results:** `case` and `output`; a run then grades those outputs.

Unknown columns, malformed rows, more than 10,000 rows, or more than 8 MiB are refused.

## Storage

`EvalStore` is implemented on Postgres (`pg`, over `oryxa-fde-store`'s eval tables from `0007_evals.sql`): each call
is one transaction scoped to the project, under forced row-level security. `finish` records the report once and
writes `EvalRunFinished` (ids and counts, an errored case counted as failed) to the outbox in the same transaction.
`InMemoryEvals` is for tests.

Case text and outputs are sample data and stay in these tables, never in events or logs. A stored output cannot
hold a NUL byte, so a target that prints one errors the case.
