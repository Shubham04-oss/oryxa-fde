import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type { ReactElement } from "react"

// Base UI's tooltip on our tokens: a short label, and the keyboard shortcut when there is one. The
// control keeps its own accessible name; the tooltip only repeats it for pointer users.

export const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <TooltipPrimitive.Provider delay={500} closeDelay={80}>
    {children}
  </TooltipPrimitive.Provider>
)

export function Tip({
  label,
  keys,
  children,
  side = "top",
}: {
  label: string
  /** Shown as keys: ["Esc"], ["Shift", "Enter"]. */
  keys?: Array<string>
  /** The control: one element, which the tooltip renders as its trigger. */
  children: ReactElement<Record<string, unknown>>
  side?: "top" | "bottom" | "left" | "right"
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup className="flex items-center gap-2 rounded-lg bg-foreground px-2 py-1 text-micro text-background shadow-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none">
            {label}
            {keys && (
              <span className="flex gap-0.5">
                {keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-background/25 px-1 font-sans text-[10px] leading-4"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            )}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
