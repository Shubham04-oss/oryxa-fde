import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Base UI's menu (arrow keys, type-ahead, Escape and focus return come from it), on the tokens
// in styles.css. Written by hand, like button.tsx.

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger
export const MenuGroup = MenuPrimitive.Group

export function MenuContent({
  children,
  label,
  finalFocus,
}: {
  children: ReactNode
  label: string
  /** Where focus goes when the menu closes; the trigger by default. */
  finalFocus?: MenuPrimitive.Popup.Props["finalFocus"]
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align="end" sideOffset={4} className="z-50 outline-none">
        <MenuPrimitive.Popup
          aria-label={label}
          finalFocus={finalFocus}
          className="min-w-44 rounded-xl border border-border bg-popover p-1 text-xs text-popover-foreground shadow-overlay outline-none"
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.GroupLabel className="px-2.5 pt-1.5 pb-1 text-[11px] text-muted-foreground">
      {children}
    </MenuPrimitive.GroupLabel>
  )
}

export function MenuItem({
  className,
  ...props
}: Omit<MenuPrimitive.Item.Props, "className"> & { className?: string }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none data-highlighted:bg-selected max-[800px]:py-2.5",
        className,
      )}
      {...props}
    />
  )
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-border" />
}
