import { parseBlocks } from "./blocks"
import type { Block, SuggestionBlock } from "./blocks"
import type { CompanySummary, TodayItem } from "@/lib/api/schemas"
import { groupToday } from "@/lib/today"

// What the welcome screen says first (issue #209): a few next steps, as suggestion blocks. Like the
// home conversation in ADR 0008, they are fixed templates over what the companies list shows (names,
// counts, days waiting) and never quote a record's own text. A model fills the same blocks later.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const where = (item: TodayItem) => `${item.company.name} · ${item.project.name}`
const project = (item: TodayItem) => ({
  screen: "project" as const,
  company: item.company.id,
  project: item.project.id,
})

/** The project with the most blocked items, and how many. */
function mostBlocked(items: Array<TodayItem>): unknown {
  const counts = new Map<string, { item: TodayItem; n: number }>()
  for (const item of items) {
    const seen = counts.get(item.project.id)
    counts.set(item.project.id, { item: seen?.item ?? item, n: (seen?.n ?? 0) + 1 })
  }
  const top = [...counts.values()].sort((x, y) => y.n - x.n)[0]!
  return {
    type: "suggestion",
    id: `blocked_${top.item.project.id}`,
    context: where(top.item),
    title: `${plural(top.n, "thing")} blocked`,
    detail: "Unblock it, or record what it waits on.",
    approve: { label: "Open the project", to: project(top.item) },
  }
}

/** The longest wait on the customer. */
function longestWait(item: TodayItem): unknown {
  const days = item.kind === "access_request" ? item.access.days_waiting : null
  return {
    type: "suggestion",
    id: `waiting_${item.kind === "task" ? item.task.id : item.access.id}`,
    context: where(item),
    title:
      item.kind === "access_request"
        ? days && days > 0
          ? `Access has waited ${plural(days, "day")}`
          : "Access is waiting on the customer"
        : "Work is waiting on the customer",
    detail: "A nudge to the person who can answer may move it.",
    approve: { label: "Open the project", to: project(item) },
  }
}

function due(items: Array<TodayItem>): unknown {
  const companies = new Set(items.map((i) => i.company.id)).size
  return {
    type: "suggestion",
    id: "due_today",
    context:
      companies === 1
        ? items[0]!.company.name
        : `Across ${plural(companies, "company", "companies")}`,
    title: `${plural(items.length, "thing")} due today`,
    approve: { label: "Open Today", to: { screen: "today" } },
  }
}

/**
 * Up to three next steps: where most is blocked, the longest wait on the customer, and what is
 * due, in that order. With fewer than three, companies with no project yet.
 */
export function suggestionsFrom(
  items: Array<TodayItem>,
  companies: Array<CompanySummary>,
  day: string,
): Array<SuggestionBlock> {
  const groups = groupToday(items, day)
  const raw: Array<unknown> = []
  if (groups.blocked.length > 0) raw.push(mostBlocked(groups.blocked))
  if (groups.waiting[0]) raw.push(longestWait(groups.waiting[0]))
  if (groups.due.length > 0) raw.push(due(groups.due))
  if (raw.length < 3)
    for (const company of companies.filter((c) => c.projects.length === 0).slice(0, 3 - raw.length))
      raw.push({
        type: "suggestion",
        id: `first_project_${company.id}`,
        context: company.name,
        title: "Start the first project",
        detail: "Every engagement needs one before work can be planned.",
        approve: { label: "Open the company", to: { screen: "company", company: company.id } },
      })
  return parseBlocks(raw).filter((b): b is SuggestionBlock => b.type === "suggestion")
}

export type Reply = { text: string; blocks: Array<Block> }

export const NEW_COMPANY: SuggestionBlock = {
  type: "suggestion",
  id: "start_new_company",
  title: "Set up a new company",
  detail: "Five short questions and a plan. Nothing is saved until you confirm.",
  approve: { label: "Start", to: { screen: "new-company" } },
}
const TODAY: SuggestionBlock = {
  type: "suggestion",
  id: "open_today",
  title: "See what needs you today",
  detail: "Blocked work, what is due, and what waits on the customer.",
  approve: { label: "Open Today", to: { screen: "today" } },
}

/**
 * The workspace's answer to what the FDE typed. Scripted: it recognises a new company and the
 * day's work, and says plainly what it cannot do yet. The text it was given is never echoed into
 * a block, only shown back as the person's own words. `suggestions` is null where there are none
 * to give (a real API, until it serves them): then it points to Today and claims nothing.
 */
export function replyTo(said: string, suggestions: Array<SuggestionBlock> | null): Reply {
  const words = said.toLowerCase()
  if (
    /\b(new|add|onboard|set up|setup|start)\b.*\b(company|customer|client|engagement)\b/.test(words)
  )
    return { text: "Let's set it up together.", blocks: [NEW_COMPANY] }
  if (/\b(today|blocked|stuck|due|waiting|next|priorit\w*|plan my)\b/.test(words))
    return suggestions === null
      ? { text: "Today shows what is blocked, due and waiting.", blocks: [TODAY] }
      : suggestions.length > 0
        ? { text: "This is where I would start.", blocks: suggestions.slice(0, 2) }
        : { text: "Nothing is blocked, due or waiting right now.", blocks: [TODAY] }
  return {
    text: "I can't act on that yet. For now I can set up a company or show you the day.",
    blocks: [NEW_COMPANY, TODAY],
  }
}
