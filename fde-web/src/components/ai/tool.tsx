// From Vercel AI Elements' `tool.tsx` (vercel/ai-elements at ca8be60), Apache-2.0, LICENSE-ai-elements.txt.
// Changed: Base UI's collapsible for Radix's; a one-line row instead of a bordered card; the status is
// a mark, not a badge; the title is given already worded (a tool's name is never shown); and no
// `ToolInput` or `ToolOutput`: raw input and output are never shown, only fixed sentences.
import type { ComponentProps } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { Icon } from "../ui/icon"
import { Shimmer } from "./shimmer"
import type { ToolState } from "@/lib/workspace/chat"
import { cn } from "@/lib/utils"

export const Tool = ({ className, ...props }: ComponentProps<typeof Collapsible>) => (
  <Collapsible className={cn("group/tool w-full", className)} {...props} />
)

const STATUS: Record<ToolState, string> = {
  "input-available": "Running",
  "output-available": "Done",
  "output-error": "Could not read",
}

/** The state as a small mark: a pulsing dot while running, a tick, or a ring in the attention colour. */
export function ToolStatus({ state }: { state: ToolState }) {
  return (
    <span aria-hidden="true" className="grid size-4 flex-none place-items-center">
      {state === "input-available" ? (
        <span className="size-1.5 rounded-full bg-tint motion-safe:animate-pulse" />
      ) : state === "output-available" ? (
        <Icon name="check" size={13} strokeWidth={2.25} className="text-muted-foreground" />
      ) : (
        <span className="size-2 rounded-full border-[1.5px] border-attention" />
      )}
    </span>
  )
}

export function ToolHeader({
  title,
  state,
  trailing,
  className,
}: {
  title: string
  state: ToolState
  /** The duration, tabular. */
  trailing?: string
  className?: string
}) {
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 rounded-md py-1 text-left text-meta text-soft transition-colors hover:text-foreground",
        className,
      )}
    >
      <ToolStatus state={state} />
      <span className="min-w-0 flex-1 truncate">
        {state === "input-available" ? <Shimmer>{`${title}…`}</Shimmer> : title}
        <span className="sr-only">, {STATUS[state]}</span>
      </span>
      {trailing && (
        <span className="flex-none text-micro text-muted-foreground tabular-nums">{trailing}</span>
      )}
      <Icon
        name="chevron-down"
        size={13}
        className="flex-none text-muted-foreground transition-transform duration-150 group-data-[open]/tool:rotate-180 in-data-[panel-open]:rotate-180"
      />
    </CollapsibleTrigger>
  )
}

export const ToolContent = ({ className, ...props }: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent className={cn("pb-1 pl-6", className)} {...props} />
)
