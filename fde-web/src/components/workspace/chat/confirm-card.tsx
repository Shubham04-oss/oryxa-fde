import { useQuery } from "@tanstack/react-query"
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationActions,
  ConfirmationRefused,
  ConfirmationRejected,
  ConfirmationRequest,
} from "../../ai/confirmation"
import { Marker, MarkerContent, MarkerIcon } from "../../ai/marker"
import { Button } from "../../ui/button"
import { Icon } from "../../ui/icon"
import type { IconName } from "../../ui/icon"
import { Tip } from "../../ui/tooltip"
import { placeOf } from "../proposal"
import { SourceChip } from "./block-card"
import { queries } from "@/lib/api/client"
import type { CompanySummary, PersonOut } from "@/lib/api/schemas"
import { ONE_AT_A_TIME, possessive } from "@/lib/workspace/chat"
import type { ChatProposal, ProposalView } from "@/lib/workspace/chat"
import { cn } from "@/lib/utils"

// A proposed action as a confirm card (ADR 0008): the action in words, its exact arguments as a labelled
// list, where it applies and as whom. Every word is built from the typed arguments and the names the
// person reads through the API, never from the model's text. Nothing runs until Confirm, which is never
// focused for the person and never bound to Enter; the kinds ADR 0008 confirms one at a time say so.

type Described = {
  action: string
  icon: IconName
  args: Array<{ label: string; value: string }>
  where: string
  /** What the person becomes or keeps, beside "You". */
  as: string
  /** For the one-at-a-time kinds: what it grants, said plainly. */
  risk?: string
  confirm: string
  done: string
  /** A name the API does not give this person: it cannot be confirmed. */
  unknown?: string
}

const ROLE: Record<"lead" | "engineer", string> = { lead: "Lead", engineer: "Engineer" }

function describe(
  p: ChatProposal,
  companies: Array<CompanySummary> | undefined,
  people: Array<PersonOut> | undefined,
): Described {
  switch (p.action) {
    case "create_company":
      return {
        action: "Create a company",
        icon: "building",
        args: [{ label: "Name", value: p.args.name }],
        where: "Your organisation's companies",
        as: "you become its lead",
        confirm: "Create company",
        done: `Created ${p.args.name}.`,
      }
    case "open_route": {
      const place = placeOf(p.args.to, companies)
      return {
        action: "Open a page",
        icon: "arrow-right",
        args: [{ label: "Page", value: place ?? "A record you can't see" }],
        where: "This browser tab. Nothing is changed.",
        as: "nothing is changed",
        confirm: "Open",
        done: `Opened ${place ?? "the page"}.`,
        unknown:
          place === null
            ? "It names a record you have no access to, so it can't be opened."
            : undefined,
      }
    }
    case "set_member": {
      const company = companies?.find((c) => c.id === p.args.company)?.name
      const person = people?.find((x) => x.id === p.args.user)?.name?.trim()
      const who = person || "This person"
      return {
        action: "Give a person a role",
        icon: "user-plus",
        args: [
          { label: "Person", value: person || "Someone not in your organisation's list" },
          { label: "Role", value: ROLE[p.args.role] },
          { label: "Company", value: company ?? "A company you can't see" },
        ],
        where: company ? `${possessive(company)} team` : "A company you can't see",
        as: "your own permissions apply",
        risk: `Grants access. ${who} will read and change every record at ${company ?? "that company"}.`,
        confirm: "Confirm",
        done: `${who} is now ${p.args.role === "lead" ? "a lead" : "an engineer"} at ${company ?? "the company"}.`,
        unknown:
          !company || !person
            ? "It names a person or company the workspace can't show you, so it can't be confirmed."
            : undefined,
      }
    }
  }
}

export function ConfirmCard({
  view,
  lead,
  blocked,
  onConfirm,
  onDismiss,
}: {
  view: ProposalView
  /** The first proposal still waiting: its Confirm is the view's one primary button. */
  lead: boolean
  /** Why it cannot be confirmed now (another is being confirmed), or null. */
  blocked: string | null
  onConfirm: () => void
  onDismiss: () => void
}) {
  const me = useQuery(queries.me())
  const companies = useQuery(queries.companies())
  const people = useQuery({ ...queries.people(), enabled: view.proposal.action === "set_member" })
  const d = describe(view.proposal, companies.data?.companies, people.data)
  const risky = ONE_AT_A_TIME.has(view.proposal.action)
  const confirming = view.phase === "confirming"
  const name = me.data?.user.name.trim()

  if (view.phase === "dismissed")
    return (
      <Confirmation
        phase="dismissed"
        aria-label={`Put away: ${d.action}`}
        className="bg-transparent py-2.5"
      >
        <ConfirmationRejected>
          <p className="flex items-center gap-2 text-meta text-muted-foreground">
            <Icon name={d.icon} size={14} />
            <span>
              <span className="line-through">{d.action}</span> · Not now. Nothing changed.
            </span>
          </p>
        </ConfirmationRejected>
      </Confirmation>
    )

  return (
    <Confirmation
      phase={view.phase}
      aria-label={`${view.phase === "done" ? "Confirmed" : "Proposed"}: ${d.action}`}
      aria-busy={confirming || undefined}
      className={cn(risky && view.phase === "waiting" && "border-attention/45")}
    >
      <header className="flex items-start gap-2.5">
        <span className="grid size-7 flex-none place-items-center rounded-lg bg-card text-muted-foreground">
          <Icon name={d.icon} size={15} />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-micro text-muted-foreground">
            {view.phase === "done" ? "Confirmed" : "Proposed. Nothing happens until you confirm."}
          </span>
          <h3 className="text-body font-semibold">{d.action}</h3>
        </span>
        {risky && view.phase !== "done" && (
          <span className="mt-0.5 inline-flex flex-none items-center gap-1 rounded-full border border-attention/40 px-2 py-0.5 text-micro font-medium text-attention">
            <Icon name="rules" size={12} />
            Grants access
          </span>
        )}
      </header>

      <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[10px] bg-card px-3 py-2.5 text-meta">
        {d.args.map((a) => (
          <div key={a.label} className="contents">
            <dt className="text-muted-foreground">{a.label}</dt>
            <dd className="font-medium break-words text-foreground">{a.value}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground">Where</dt>
        <dd className="break-words text-soft">{d.where}</dd>
        <dt className="text-muted-foreground">As</dt>
        <dd className="break-words text-soft">
          You{name ? ` (${name})` : ""}, {d.as}
        </dd>
      </dl>

      <ConfirmationRequest>
        {d.risk && (
          <p className="flex items-start gap-2 text-meta text-soft">
            <Icon name="alert" size={14} className="mt-0.5 flex-none text-attention" />
            <span>{d.risk} It is confirmed on its own, never with other changes.</span>
          </p>
        )}
        {d.unknown && <p className="text-meta text-muted-foreground">{d.unknown}</p>}
      </ConfirmationRequest>

      <ConfirmationAccepted>
        <Marker role="status">
          <MarkerIcon className="text-success">
            <Icon name="check" size={14} strokeWidth={2.25} />
          </MarkerIcon>
          <MarkerContent className="text-soft">{d.done}</MarkerContent>
          {view.record && view.proposal.action !== "open_route" && (
            <span className="ml-auto flex-none">
              <SourceChip
                to={view.record}
                names={{
                  company:
                    view.record.screen === "company"
                      ? companies.data?.companies.find(
                          (c) => view.record?.screen === "company" && c.id === view.record.company,
                        )?.name
                      : undefined,
                }}
              />
            </span>
          )}
        </Marker>
      </ConfirmationAccepted>

      <ConfirmationRefused>
        <Marker role="alert" tone="error">
          <MarkerIcon>
            <Icon name="alert" size={14} />
          </MarkerIcon>
          <MarkerContent className="text-soft">
            <span className="font-medium text-foreground">The workspace refused this. </span>
            {view.reason}
          </MarkerContent>
        </Marker>
      </ConfirmationRefused>

      <ConfirmationActions>
        {view.phase !== "refused" && !d.unknown && (
          <Tip label={blocked ?? (risky ? "Confirm this change on its own" : "Confirm")}>
            <Button
              variant={lead && !blocked ? "default" : "outline"}
              aria-disabled={blocked || confirming ? true : undefined}
              onClick={() => {
                if (!blocked && !confirming) onConfirm()
              }}
              className={cn((blocked || confirming) && "opacity-45")}
            >
              {confirming ? "Confirming…" : d.confirm}
            </Button>
          </Tip>
        )}
        <Button variant="ghost" onClick={onDismiss} disabled={confirming}>
          Not now
        </Button>
        {blocked && view.phase === "waiting" && (
          <span className="text-micro text-muted-foreground">{blocked}</span>
        )}
      </ConfirmationActions>
    </Confirmation>
  )
}
