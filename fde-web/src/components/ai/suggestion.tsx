// From Vercel AI Elements' `suggestion.tsx` (vercel/ai-elements at ca8be60), Apache-2.0,
// LICENSE-ai-elements.txt. Changed: a wrapping list instead of Radix's ScrollArea (a phone shows every
// prompt), our pill on our tokens, and an icon.
import type { ComponentProps } from "react"
import { Icon } from "../ui/icon"
import type { IconName } from "../ui/icon"
import { cn } from "@/lib/utils"

export const Suggestions = ({ className, ...props }: ComponentProps<"ul">) => (
  <ul className={cn("flex flex-wrap gap-2 max-[560px]:grid", className)} {...props} />
)

export function Suggestion({
  suggestion,
  icon,
  onClick,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onClick"> & {
  suggestion: string
  icon?: IconName
  onClick: (suggestion: string) => void
}) {
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => onClick(suggestion)}
        className={cn(
          "inline-flex h-9 max-w-full items-center gap-2 rounded-full border bg-canvas px-3.5 text-meta text-soft transition-[background-color,border-color,color,transform] duration-150 hover:border-strong hover:text-foreground disabled:opacity-45 motion-safe:active:scale-[0.98] max-[560px]:w-full",
          className,
        )}
        {...props}
      >
        {icon && <Icon name={icon} size={14} className="flex-none text-muted-foreground" />}
        <span className="truncate">{suggestion}</span>
      </button>
    </li>
  )
}
