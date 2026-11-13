import { Destination, parseBlock } from "./blocks"
import type { Block, SuggestionBlock } from "./blocks"
import type { HomeSuggestionOut } from "@/lib/api/schemas"

// What the welcome screen says first: the API's home suggestions (`GET /v1/home`, issue #256), as
// suggestion blocks. The API sends a kind, counts, names and a route; the words for each kind are
// fixed here (ADR 0008), so nothing from the answer is ever shown but a name, as text.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** A suggestion's id as the API makes it (`<kind>` or `<kind>.<project id>`), safe to send back. */
const SUGGESTION_ID = /^[a-z_]{1,32}(\.[A-Za-z0-9_-]{1,128})?$/
/** The block's `context` limit; two long names are shortened rather than lose the suggestion. */
const CONTEXT_MAX = 160

/**
 * The route a suggestion opens, only if it is one of our own screens: Today, a company or one of
 * its projects. Anything else (another host, a query, an id that breaks the rule) is null.
 */
export function destinationOf(route: string): Destination | null {
  const m = /^\/(?:(today)|companies\/([^/]+)(?:\/projects\/([^/]+))?)$/.exec(route)
  if (!m) return null
  const [, today, company, project] = m
  const to = today
    ? { screen: "today" }
    : project
      ? { screen: "project", company, project }
      : { screen: "company", company }
  const parsed = Destination.safeParse(to)
  return parsed.success ? parsed.data : null
}

type Wording = Pick<SuggestionBlock, "context" | "title" | "detail"> & { label: string }

/** The fixed words for each kind; null where the answer lacks what the kind needs. */
function wording(s: HomeSuggestionOut): Wording | null {
  const where = s.company && s.project ? `${s.company.name} · ${s.project.name}` : null
  const n = s.count
  switch (s.kind) {
    case "due_today":
      return {
        context: "Across your projects",
        title: `${plural(n, "task")} due today`,
        detail: "Finish what you can, or move the date.",
        label: "Open Today",
      }
    case "access_waiting": {
      if (!where) return null
      const days = s.days ?? 0
      return {
        context: where,
        title:
          n > 1
            ? `${n} access requests waiting on the customer`
            : days > 0
              ? `Access has waited ${plural(days, "day")}`
              : "Access is waiting on the customer",
        detail:
          n > 1 && days > 0
            ? `The longest has waited ${plural(days, "day")}. A nudge may move it.`
            : "A nudge to the person who can answer may move it.",
        label: "Open the project",
      }
    }
    case "blocked_tasks":
      if (!where) return null
      return {
        context: where,
        title: `${plural(n, "task")} blocked`,
        detail: `Unblock ${n === 1 ? "it" : "them"}, or record what ${n === 1 ? "it waits" : "they wait"} on.`,
        label: "Open the project",
      }
    case "no_next_step":
      if (!where) return null
      return {
        context: where,
        title: "No next step",
        detail: "Add the next task, or close the engagement.",
        label: "Open the project",
      }
    default:
      return null
  }
}

const shorten = (v: string, max: number) => {
  const chars = [...v]
  return chars.length <= max ? v : `${chars.slice(0, max - 1).join("")}…`
}

/** A home suggestion as the welcome screen shows it: the API's id (to dismiss it) and its block. */
export type HomeSuggestion = { id: string; block: SuggestionBlock }

/**
 * The API's suggestions as blocks, in its order. One is skipped when its kind is unknown, its id is
 * not one the API makes, its route is not one of our own screens, or the block does not validate.
 */
export function suggestionsFromHome(suggestions: Array<HomeSuggestionOut>): Array<HomeSuggestion> {
  return suggestions.flatMap((s, i) => {
    const to = destinationOf(s.route)
    const words = wording(s)
    if (!to || !words || !SUGGESTION_ID.test(s.id)) return []
    const { label, ...rest } = words
    const block = parseBlock({
      type: "suggestion",
      id: `home_${i}`,
      ...rest,
      context: rest.context && shorten(rest.context, CONTEXT_MAX),
      approve: { label, to },
    })
    return block?.type === "suggestion" ? [{ id: s.id, block }] : []
  })
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
