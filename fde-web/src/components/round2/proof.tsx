import { useQuery } from "@tanstack/react-query"
import { evalsOff, queries } from "@/lib/api/client"
import type { Project, ProjectScope } from "@/lib/api/schemas"
import { STATUS, counts, proofs, targetText, trendText, valueText } from "@/lib/proof"
import { trackOf, withUnit } from "@/lib/round2"
import { cn } from "@/lib/utils"
import { Block, Num, R2Button, Skeleton, StatusMark } from "./ui"
import { Spark, TrackBar } from "./visuals"

const COLS =
  "grid grid-cols-[minmax(0,1fr)_minmax(200px,1fr)_112px_64px] items-center gap-x-6 max-[900px]:grid-cols-[minmax(0,1fr)_64px] max-[900px]:gap-y-3"

/**
 * Proof: each success criterion as a picture. Baseline to target on a track with the current value
 * marked, the recent results as a small trend, and the value itself, with the API's verdict in words.
 * "Met" is the API's, as on the project page (lib/proof.ts). A screen reader hears each in a sentence.
 */
export function ProofTab({
  scope,
  project: p,
  onAddCriterion,
}: {
  scope: ProjectScope
  project: Project
  onAddCriterion: () => void
}) {
  const suites = useQuery(queries.evalSuites(scope))
  const runs = useQuery(queries.evalRuns(scope))
  const room = useQuery(queries.room(scope))
  const off = evalsOff(suites.error) || evalsOff(runs.error)
  const criteria = p.scope.criteria

  if (criteria.length === 0)
    return (
      <div className="grid justify-items-start gap-3 rounded-r2 border border-dashed px-(--r2-pad) py-8">
        <p className="text-r2-body font-semibold">No success criteria yet</p>
        <R2Button size="sm" onClick={onAddCriterion}>
          Add criterion
        </R2Button>
      </div>
    )

  const loading = !off && (suites.isPending || runs.isPending || room.isPending)
  const failed = !off && (suites.isError || runs.isError || room.isError)
  const rows = proofs(criteria, room.data?.criteria, suites.data ?? [], runs.data ?? [])
  const met = rows.filter((r) => r.status === "met").length
  const list = suites.data ?? []

  return (
    <div className="grid gap-(--r2-gap)">
      <Block
        title="Success criteria"
        flush
        aside={
          room.data && (
            <span className="text-r2-meta text-muted-foreground tabular-nums">
              {met} of {rows.length} met
            </span>
          )
        }
      >
        <div
          className={cn(
            "r2-colhead border-t px-(--r2-pad) py-2 text-r2-meta text-muted-foreground max-[640px]:hidden",
            COLS,
          )}
        >
          <span>Criterion</span>
          <span className="max-[900px]:hidden">Baseline to target</span>
          <span className="max-[900px]:hidden">Trend</span>
          <span className="text-right">Now</span>
        </div>
        {loading ? (
          <Skeleton rows={3} label="Reading the results…" />
        ) : failed ? (
          <p
            role="alert"
            className="flex items-center justify-between gap-3 border-t px-(--r2-pad) py-3 text-r2-meta text-muted-foreground"
          >
            We couldn't read the results.
            <R2Button
              level="quiet"
              size="sm"
              onClick={() => {
                void suites.refetch()
                void runs.refetch()
                void room.refetch()
              }}
            >
              Try again
            </R2Button>
          </p>
        ) : (
          <ul>
            {rows.map((r) => {
              const c = r.criterion
              const status = STATUS[r.status]
              const legend = [
                c.baseline != null
                  ? `Baseline ${withUnit(valueText(c.baseline), c.unit)}`
                  : "No baseline",
                `Target ${targetText(c)}`,
              ].join(" · ")
              return (
                <li key={c.id} className={cn("border-t px-(--r2-pad) py-4", COLS)}>
                  <div className="grid min-w-0 gap-1">
                    <p className="text-r2-body font-medium [overflow-wrap:anywhere]">
                      {c.description}
                    </p>
                    <StatusMark tone={status.tone}>{status.label}</StatusMark>
                  </div>
                  <div className="grid gap-1.5 max-[900px]:col-span-2 max-[900px]:row-start-2">
                    <TrackBar track={trackOf(c, r.value)} tone={status.tone} />
                    <p className="text-r2-meta text-muted-foreground tabular-nums">{legend}</p>
                  </div>
                  <div className="max-[900px]:col-span-2 max-[900px]:row-start-3">
                    {r.trend.length > 0 && (
                      <Spark rates={r.trend.map((t) => t.rate)} target={c.target} />
                    )}
                  </div>
                  <Num
                    className={cn(
                      "text-r2-body font-semibold max-[900px]:col-start-2 max-[900px]:row-start-1 max-[900px]:self-start",
                      r.value === null && "font-normal text-muted-foreground",
                    )}
                  >
                    {r.value === null ? "None" : valueText(r.value)}
                  </Num>
                  <span className="sr-only">
                    {c.description}: {status.label}. {legend}.{" "}
                    {r.value !== null && `Now ${valueText(r.value)}. `}
                    {trendText(r.trend)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Block>

      {list.length > 0 && (
        <Block
          title="Eval suites"
          flush
          aside={<Num className="text-r2-meta text-muted-foreground">{list.length}</Num>}
        >
          <div
            className={cn(
              "r2-colhead border-t px-(--r2-pad) py-2 text-r2-meta text-muted-foreground max-[640px]:hidden",
              SUITE_COLS,
            )}
          >
            <span>Suite</span>
            <span className="text-right max-[640px]:hidden">Cases</span>
            <span className="text-right">Last run</span>
          </div>
          <ul>
            {list.map((s) => {
              const last = (runs.data ?? [])
                .filter((r) => r.suite === s.id && r.state === "finished")
                .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
              const c = last ? counts(last) : null
              return (
                <li
                  key={s.id}
                  className={cn("min-h-(--r2-row) border-t px-(--r2-pad) py-2", SUITE_COLS)}
                >
                  <span className="truncate text-r2-body">{s.name}</span>
                  <Num className="text-r2-meta text-muted-foreground max-[640px]:hidden">
                    {s.cases.length}
                  </Num>
                  <Num className="text-r2-meta">
                    {c ? (
                      `${c.passed} of ${c.cases} passed`
                    ) : (
                      <span className="text-muted-foreground">Not run</span>
                    )}
                  </Num>
                </li>
              )
            })}
          </ul>
        </Block>
      )}
    </div>
  )
}

const SUITE_COLS =
  "grid grid-cols-[minmax(0,1fr)_64px_160px] items-center gap-x-6 max-[640px]:grid-cols-[minmax(0,1fr)_auto]"
