import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Card, Failed, Loading, Page, Quiet, Row, Rows, Status } from "./page"
import { ActiveRunsCard } from "./runs"
import type { Tone } from "./page"
import { queries } from "@/lib/api/client"
import type { TodayItem } from "@/lib/api/schemas"
import { dayOf, daysBetween, dueLabel, localDay, waitingLabel } from "@/lib/time"
import { TODAY_GROUPS, groupToday } from "@/lib/today"
import type { TodayGroup } from "@/lib/today"

/** What an item is, in a few words. */
function itemTitle(item: TodayItem) {
  return item.kind === "task" ? item.task.title : `Access: ${item.access.description}`
}

/** Why it is in its group, and how urgent: the reason a row is there. */
function reason(item: TodayItem, group: TodayGroup, today: string): { text: string; tone: Tone } {
  if (item.kind === "access_request") {
    const { access } = item
    const owner = item.owner ?? null
    const by = owner ? ` by ${owner}` : ""
    if (access.status === "denied") return { text: `Denied${by}`, tone: "attention" }
    if (access.status === "revoked") return { text: `Revoked${by}`, tone: "attention" }
    return { text: waitingLabel(access.days_waiting, owner), tone: "neutral" }
  }
  const { task } = item
  if (group === "blocked") return { text: task.blocker || "Blocked", tone: "attention" }
  if (group === "waiting") {
    const since = dayOf(task.waiting_since ?? task.updated_at)
    return { text: waitingLabel(daysBetween(since, today), null), tone: "neutral" }
  }
  const due = task.due_on ?? today
  return { text: dueLabel(due, today), tone: daysBetween(today, due) < 0 ? "attention" : "neutral" }
}

/**
 * Today (DESIGN.md §3): what needs the FDE across every company, in three groups. It says "all
 * clear" only once the API has answered.
 */
export function TodayView({ today = localDay() }: { today?: string }) {
  const items = useQuery(queries.today())

  if (items.isPending)
    return (
      <Page>
        <Loading>Gathering what needs you today…</Loading>
      </Page>
    )
  if (items.isError)
    return (
      <Page>
        <Failed
          title="We couldn't load Today."
          error={items.error}
          onRetry={() => void items.refetch()}
        />
      </Page>
    )

  const groups = groupToday(items.data.items, today)
  const counts = TODAY_GROUPS.map(({ key }) => groups[key].length)
  const companies = new Set(
    TODAY_GROUPS.flatMap(({ key }) => groups[key].map((item) => item.company.id)),
  ).size

  return (
    <Page>
      <p className="text-xs text-muted-foreground">
        {counts.every((n) => n === 0)
          ? "Nothing needs you today."
          : `${counts[0]} blocked, ${counts[1]} due and ${counts[2]} waiting on the customer, across ${companies} ${companies === 1 ? "company" : "companies"}.`}
      </p>
      {TODAY_GROUPS.map(({ key, title, empty }) => (
        <Card
          key={key}
          title={title}
          aside={<span className="text-[11px] text-muted-foreground">{groups[key].length}</span>}
        >
          {groups[key].length === 0 ? (
            <Quiet>{empty}</Quiet>
          ) : (
            <Rows>
              {groups[key].map((item) => {
                const why = reason(item, key, today)
                return (
                  <Row key={`${item.kind}:${item.kind === "task" ? item.task.id : item.access.id}`}>
                    <Link
                      to="/companies/$companyId/projects/$projectId"
                      params={{ companyId: item.company.id, projectId: item.project.id }}
                      className="group flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs group-hover:underline group-hover:underline-offset-2">
                          {itemTitle(item)}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {item.company.name} · {item.project.name}
                        </span>
                      </span>
                      <Status tone={why.tone}>{why.text}</Status>
                    </Link>
                  </Row>
                )
              })}
            </Rows>
          )}
        </Card>
      ))}
      <ActiveRunsCard />
    </Page>
  )
}
