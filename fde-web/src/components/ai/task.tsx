// From Vercel AI Elements' `task.tsx` (vercel/ai-elements at ca8be60), Apache-2.0, LICENSE-ai-elements.txt.
// Changed: Base UI's collapsible for Radix's (its `render` for `asChild`), our tokens and icons. Used as
// the steps strip of a turn: the trigger is the folded line ("Read 3 things"), the content the steps.
import type { ComponentProps, ReactNode } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { Icon } from "../ui/icon"
import { cn } from "@/lib/utils"

export const Task = ({ className, ...props }: ComponentProps<typeof Collapsible>) => (
  <Collapsible className={cn("group/task", className)} {...props} />
)

export function TaskTrigger({
  title,
  extra,
  className,
}: {
  title: ReactNode
  extra?: ReactNode
  className?: string
}) {
  return (
    <CollapsibleTrigger
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-md py-1 text-meta text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <Icon name="search" size={14} className="flex-none" />
      <span className="truncate">{title}</span>
      {extra}
      <Icon
        name="chevron-down"
        size={13}
        className="flex-none transition-transform duration-150 in-data-[panel-open]:rotate-180"
      />
    </CollapsibleTrigger>
  )
}

export const TaskContent = ({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent className={className} {...props}>
    <div className="mt-1 ml-[7px] grid gap-0.5 border-l border-border pl-3">{children}</div>
  </CollapsibleContent>
)

export const TaskItem = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("text-meta text-muted-foreground", className)} {...props} />
)
