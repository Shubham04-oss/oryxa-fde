import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "@/lib/utils"

// shadcn's base-nova dialog on Base UI (focus trap, Escape, scroll lock and labelling come from
// Base UI), on the tokens in styles.css. Written by hand, like button.tsx.

export const Dialog = DialogPrimitive.Root
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description
export const DialogClose = DialogPrimitive.Close

type ContentProps = Omit<DialogPrimitive.Popup.Props, "className"> & { className?: string }

export function DialogContent({ className, children, ...props }: ContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 z-40 bg-scrim data-ending-style:opacity-0 data-starting-style:opacity-0 motion-safe:transition-opacity"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-[12vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border border-border bg-popover text-popover-foreground shadow-overlay outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}
