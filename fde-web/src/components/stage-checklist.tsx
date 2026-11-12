import { Link } from "@tanstack/react-router"
import { Card, Quiet, Row, Rows, Status } from "./page"
import { Button, buttonVariants } from "./ui/button"
import type { CompanyId, Project, StageChecklist as Checklist } from "@/lib/api/schemas"
import { hintFor, metSummary, openCount } from "@/lib/checklist"
import type { Fix } from "@/lib/checklist"
import { STAGE_LABEL } from "@/lib/stage"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

const BUTTON = cn(buttonVariants({ variant: "outline", size: "sm" }), "max-[800px]:h-9")

/**
 * What the project's stage needs before it moves on (DESIGN.md §3), right under the stage bar: each
 * item with whether it is met and, for an open one, what is missing in plain words and the button
 * that goes to where it is put right. Open items are information, not errors: no red, and no amber
 * either (that is for a move that is held up). When all are met it is one quiet line.
 */
export function StageChecklist({
  project,
  checklist,
  onFix,
}: {
  project: Project
  checklist: Checklist
  /** Goes to where an item is fixed on this page: opens its dialog, or scrolls to its card. */
  onFix: (fix: Exclude<Fix, "add-stakeholder">) => void
}) {
  const { items, stage } = checklist
  // Nothing to check at this stage yet.
  if (items.length === 0) return null
  const name = `To leave ${STAGE_LABEL[stage]}`

  if (openCount(items) === 0)
    return (
      <section aria-label={name}>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon
            name="check"
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className="flex-none text-success"
          />
          Ready to leave {STAGE_LABEL[stage]}. Everything it needs is in place.
        </p>
      </section>
    )

  return (
    <Card title={name} aside={<Status tone="neutral">{metSummary(items)}</Status>}>
      <Rows>
        {items.map((item) => {
          const hint = item.met ? undefined : hintFor(item.key, project)
          const fix = hint?.fix
          return (
            <Row key={item.key}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                <div className="flex min-w-0 flex-1 basis-60 items-start gap-2.5">
                  {item.met ? (
                    <Icon
                      name="check"
                      size={14}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="mt-0.5 flex-none text-success"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="mt-[3px] size-3 flex-none rounded-full border border-strong"
                    />
                  )}
                  <div className="min-w-0">
                    <p className={cn("text-xs", item.met && "text-muted-foreground")}>
                      <span className="sr-only">{item.met ? "Met: " : "Open: "}</span>
                      {item.label}
                    </p>
                    {!item.met && <Quiet>{hint?.missing ?? "This is not met yet."}</Quiet>}
                  </div>
                </div>
                {fix && <FixButton fix={fix} company={project.company.id} onFix={onFix} />}
              </div>
            </Row>
          )
        })}
      </Rows>
    </Card>
  )
}

/** The button to where an item is put right: a link to the company page, or something on this one. */
function FixButton({
  fix,
  company,
  onFix,
}: {
  fix: { do: Fix; label: string }
  company: CompanyId
  onFix: (fix: Exclude<Fix, "add-stakeholder">) => void
}) {
  const to = fix.do
  if (to === "add-stakeholder")
    return (
      <Link
        to="/companies/$companyId"
        params={{ companyId: company }}
        search={{ add: "stakeholder" }}
        aria-label={`${fix.label}, on the company page`}
        className={BUTTON}
      >
        {fix.label}
      </Link>
    )
  return (
    <Button variant="outline" size="sm" className="max-[800px]:h-9" onClick={() => onFix(to)}>
      {fix.label}
    </Button>
  )
}
