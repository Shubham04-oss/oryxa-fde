// From Vercel AI Elements' `plan.tsx` (vercel/ai-elements at ca8be60), Apache-2.0, LICENSE-ai-elements.txt.
// Changed: a plain bordered section on our tokens instead of shadcn's Card, Base UI's collapsible for
// Radix's, and no `PlanAction`. The title shimmers while the turn streams. Used for the turn's own
// checklist, whose items tick as the work they are tied to finishes.
import type { ComponentProps, ReactNode } from "react"
import { createContext, useContext } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { Icon } from "../ui/icon"
import { Shimmer } from "./shimmer"
import { cn } from "@/lib/utils"

const PlanContext = createContext({ isStreaming: false })

export function Plan({
  isStreaming = false,
  className,
  ...props
}: ComponentProps<typeof Collapsible> & { isStreaming?: boolean }) {
  return (
    <PlanContext.Provider value={{ isStreaming }}>
      <Collapsible
        data-slot="plan"
        className={cn("rounded-[14px] border bg-card", className)}
        {...props}
      />
    </PlanContext.Provider>
  )
}

export function PlanHeader({ title, extra }: { title: string; extra?: ReactNode }) {
  const { isStreaming } = useContext(PlanContext)
  return (
    <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-meta font-medium text-soft">
      <span className="min-w-0 flex-1 truncate">
        {isStreaming ? <Shimmer>{title}</Shimmer> : title}
      </span>
      {extra}
      <Icon
        name="chevron-down"
        size={13}
        className="flex-none text-muted-foreground transition-transform duration-150 in-data-[panel-open]:rotate-180"
      />
    </CollapsibleTrigger>
  )
}

export const PlanContent = ({ className, ...props }: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent className={cn("border-t px-4 py-3", className)} {...props} />
)
