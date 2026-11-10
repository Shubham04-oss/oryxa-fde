import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CompanyDialog } from "./company-forms"
import { Failed, Loading, Page, Quiet, Status } from "./page"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { queries } from "@/lib/api/client"
import type { CompanyRole } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"
import { localDay } from "@/lib/time"
import { groupOf } from "@/lib/today"

export const ROLE_LABEL: Record<CompanyRole, string> = {
  lead: "Lead",
  engineer: "Engineer",
  admin: "Organisation admin",
}

type Counts = { blocked: number; due: number; waiting: number }

/** Today's counts for one company, in words, or null when nothing needs the FDE there. */
function attention(counts: Counts | undefined) {
  if (!counts) return null
  const parts = [
    counts.blocked && `${counts.blocked} blocked`,
    counts.due && `${counts.due} due`,
    counts.waiting && `${counts.waiting} waiting`,
  ].filter(Boolean)
  return parts.length ? { text: parts.join(" · "), urgent: counts.blocked > 0 } : null
}

/**
 * Home (DESIGN.md §3): the FDE's companies, each with its projects and stages and what needs the
 * FDE there today.
 */
export function CompaniesHome() {
  const companies = useQuery(queries.companies())
  // Optional: the cards still show if Today cannot be read.
  const today = useQuery(queries.today())
  const [creating, setCreating] = useState(false)

  if (companies.isPending)
    return (
      <Page>
        <Loading>Loading your companies…</Loading>
      </Page>
    )
  if (companies.isError)
    return (
      <Page>
        <Failed
          title="We couldn't load your companies."
          error={companies.error}
          onRetry={() => void companies.refetch()}
        />
      </Page>
    )
  const newCompany = (
    <Dialog open={creating} onOpenChange={setCreating}>
      {creating && <CompanyDialog onClose={() => setCreating(false)} />}
    </Dialog>
  )
  // The first minute of an engagement: say what a company is, and what to do first.
  if (companies.data.companies.length === 0)
    return (
      <Page>
        <div className="grid justify-items-start gap-3 rounded-[15px] border border-dashed border-strong p-5">
          <strong className="text-[13px] font-semibold">Add your first company</strong>
          <Quiet>
            A company is a customer you work with. Add it, then the people you work with there and
            the systems the work touches, then start a project. If your organisation adds you to a
            company, it shows here too.
          </Quiet>
          <Button onClick={() => setCreating(true)}>New company</Button>
        </div>
        {newCompany}
      </Page>
    )

  const day = localDay()
  const counts = new Map<string, Counts>()
  for (const item of today.data?.items ?? []) {
    const group = groupOf(item, day)
    if (!group) continue
    const c = counts.get(item.company.id) ?? { blocked: 0, due: 0, waiting: 0 }
    c[group] += 1
    counts.set(item.company.id, c)
  }

  return (
    <Page wide>
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => setCreating(true)}>
          New company
        </Button>
      </div>
      <ul aria-label="Your companies" className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
        {companies.data.companies.map((company) => {
          const needs = today.isSuccess ? attention(counts.get(company.id)) : null
          return (
            <li key={company.id} className="min-w-0">
              <Link
                to="/companies/$companyId"
                params={{ companyId: company.id }}
                className="flex h-full flex-col gap-3 rounded-[14px] border bg-card px-5 py-[18px] hover:border-strong max-[800px]:p-4"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-semibold">{company.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {[company.industry, company.role && ROLE_LABEL[company.role]]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="grid gap-1 text-xs">
                  {company.projects.length === 0 && (
                    <span className="text-muted-foreground">No projects yet.</span>
                  )}
                  {company.projects.map((project) => (
                    <span key={project.id} className="flex justify-between gap-3">
                      <span className="truncate">{project.name}</span>
                      <span className="flex-none text-muted-foreground">
                        {STAGE_LABEL[project.stage]}
                      </span>
                    </span>
                  ))}
                </span>
                <span className="mt-auto">
                  {needs ? (
                    <Status tone={needs.urgent ? "attention" : "neutral"}>{needs.text}</Status>
                  ) : today.isSuccess ? (
                    <Status tone="neutral">Nothing needs you today</Status>
                  ) : null}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      {newCompany}
    </Page>
  )
}
