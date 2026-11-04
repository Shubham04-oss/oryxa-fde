import { useEffect, useId, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Building2, FolderKanban, Search } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog"
import { queries } from "@/lib/api/client"
import type { CompanySummary, ProjectSummaryOut } from "@/lib/api/schemas"
import { STAGE_LABEL } from "@/lib/stage"
import { cn } from "@/lib/utils"

export type SwitchTarget =
  | { kind: "company"; company: CompanySummary }
  | { kind: "project"; company: CompanySummary; project: ProjectSummaryOut }

/** Every place Jump to can open: each company, then each of its projects. */
export function switchTargets(companies: Array<CompanySummary>): Array<SwitchTarget> {
  return companies.flatMap((company) => [
    { kind: "company" as const, company },
    ...company.projects.map((project) => ({ kind: "project" as const, company, project })),
  ])
}

/** Targets whose names hold every word typed, in any order, ignoring case. */
export function matchTargets(targets: Array<SwitchTarget>, query: string): Array<SwitchTarget> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return targets.filter((target) => {
    const text = `${target.company.name} ${target.kind === "project" ? target.project.name : ""}`
    return words.every((word) => text.toLowerCase().includes(word))
  })
}

/** Ctrl K or ⌘ K anywhere opens Jump to. */
export function useJumpShortcut(open: () => void) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return
      if (event.altKey || event.shiftKey) return
      event.preventDefault()
      open()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
}

/**
 * Jump to (DESIGN.md §2): quick switching between companies and projects from the keyboard.
 * Type to filter, arrows to move, Enter to open, Escape to close.
 */
export function QuickSwitch({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (target: SwitchTarget) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={input}>
        <DialogTitle className="sr-only">Jump to</DialogTitle>
        <Switcher
          input={input}
          onSelect={(target) => {
            onOpenChange(false)
            onSelect(target)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function Switcher({
  input,
  onSelect,
}: {
  input: React.RefObject<HTMLInputElement | null>
  onSelect: (target: SwitchTarget) => void
}) {
  const companies = useQuery(queries.companies())
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const list = useId()
  const results = matchTargets(switchTargets(companies.data?.companies ?? []), query)
  const optionId = (i: number) => `${list}-${i}`
  const current = results.length ? Math.min(active, results.length - 1) : -1

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" })
  })

  function onKeyDown(event: React.KeyboardEvent) {
    const n = results.length
    if (event.key === "ArrowDown" && n) setActive((current + 1) % n)
    else if (event.key === "ArrowUp" && n) setActive((current - 1 + n) % n)
    else if (event.key === "Enter" && current >= 0) onSelect(results[current]!)
    else return
    event.preventDefault()
  }

  return (
    <div className="text-[13px]">
      <div className="flex items-center gap-2.5 border-b px-4">
        <Search size={16} strokeWidth={1.7} aria-hidden="true" className="text-muted-foreground" />
        <input
          ref={input}
          role="combobox"
          aria-label="Jump to a company or project"
          aria-expanded="true"
          aria-controls={list}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          placeholder="Jump to a company or project"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground max-[800px]:text-base"
        />
      </div>
      <ul
        id={list}
        role="listbox"
        aria-label="Companies and projects"
        className="max-h-[min(380px,55vh)] overflow-y-auto p-1.5"
      >
        {results.map((target, i) => {
          const Icon = target.kind === "company" ? Building2 : FolderKanban
          return (
            <li
              key={target.kind === "company" ? target.company.id : target.project.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              onMouseMove={() => setActive(i)}
              onClick={() => onSelect(target)}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2",
                i === current && "bg-selected",
              )}
            >
              <Icon
                size={16}
                strokeWidth={1.7}
                aria-hidden="true"
                className="text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">
                {target.kind === "company" ? target.company.name : target.project.name}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {target.kind === "company"
                  ? target.company.industry
                  : `${target.company.name} · ${STAGE_LABEL[target.project.stage]}`}
              </span>
            </li>
          )
        })}
      </ul>
      {companies.isPending && <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>}
      {companies.isError && (
        <p role="alert" className="px-4 pb-4 text-xs text-destructive">
          Couldn't load your companies. Close and try again.
        </p>
      )}
      {companies.isSuccess && results.length === 0 && (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Nothing matches “{query}”.</p>
      )}
    </div>
  )
}
