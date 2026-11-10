import type { QueryClient } from "@tanstack/react-query"
import { queries } from "./api/client"
import type { EvalRunOut, SuiteOut } from "./api/evals"
import type { ProjectScope } from "./api/schemas"

// What the Proof cards do to the cache once the API has confirmed something: nothing is shown as created,
// started or imported before then. A write sent before a read would land after it with the old list, so the
// reads of that list are cancelled first.

/** The reads a proof change can reach: the stage checklist's eval items, and the room's verdicts. */
function reread(client: QueryClient, scope: ProjectScope) {
  void client.invalidateQueries({ queryKey: queries.stageChecklist(scope).queryKey })
  void client.invalidateQueries({ queryKey: queries.room(scope).queryKey })
}

/** A suite the API has stored, new or with cases added. Its criteria now have an eval suite, which the checklist reads. */
export async function commitSuite(client: QueryClient, scope: ProjectScope, saved: SuiteOut) {
  const key = queries.evalSuites(scope).queryKey
  await client.cancelQueries({ queryKey: key })
  client.setQueryData(key, (old) =>
    old
      ? old.some((s) => s.id === saved.id)
        ? old.map((s) => (s.id === saved.id ? saved : s))
        : [saved, ...old]
      : [saved],
  )
  void client.invalidateQueries({ queryKey: key })
  reread(client, scope)
}

/** A run the API has accepted, `running`: the first of the list. */
export async function commitRun(client: QueryClient, scope: ProjectScope, run: EvalRunOut) {
  const key = queries.evalRuns(scope).queryKey
  await client.cancelQueries({ queryKey: key })
  client.setQueryData(key, (old) => (old ? [run, ...old.filter((r) => r.id !== run.id)] : [run]))
}

/** A run the API now says has finished: its report is in the list, and every verdict that rests on it is read again. */
export async function commitRunFinished(client: QueryClient, scope: ProjectScope, run: EvalRunOut) {
  const key = queries.evalRuns(scope).queryKey
  await client.cancelQueries({ queryKey: key })
  client.setQueryData(key, (old) => old?.map((r) => (r.id === run.id ? run : r)))
  // The list is the truth about the rest of the runs, so it is read once more.
  void client.invalidateQueries({ queryKey: key })
  reread(client, scope)
}
