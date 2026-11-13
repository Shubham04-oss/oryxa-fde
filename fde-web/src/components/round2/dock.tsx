import { Dialog } from "@base-ui/react/dialog"
import { Icon } from "@/components/ui/icon"
import { Voice } from "@/components/workspace/welcome"
import { r2Button } from "./ui"

/**
 * Where the project's conversation will dock: a button that opens an empty panel, on the right on a
 * desktop and as a sheet from the bottom on a phone. The conversation itself is a separate prototype, so
 * the panel holds no composer and claims nothing works. Escape or Close puts focus back on the button.
 */
export function Dock({ project }: { project: string }) {
  return (
    <Dialog.Root modal={false}>
      <Dialog.Trigger className={r2Button({ level: "secondary", size: "sm" })}>
        <Icon name="sparkle" size={15} className="text-brand" />
        Ask
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Popup className="fixed top-2 right-2 bottom-2 z-40 flex w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden rounded-r2 border bg-canvas shadow-overlay outline-none motion-safe:animate-panel max-[640px]:top-auto max-[640px]:right-0 max-[640px]:bottom-0 max-[640px]:left-0 max-[640px]:h-[70vh] max-[640px]:w-full max-[640px]:rounded-b-none max-[640px]:motion-safe:animate-rise">
          <header className="flex min-h-(--r2-row) items-center justify-between gap-3 border-b px-(--r2-pad)">
            <Dialog.Title className="flex min-w-0 items-center gap-2 text-r2-body font-semibold">
              <Voice />
              <span className="truncate">{project}</span>
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="grid size-8 place-items-center rounded-r2-control text-muted-foreground hover:bg-selected hover:text-foreground"
            >
              <Icon name="close" size={16} />
            </Dialog.Close>
          </header>
          <Dialog.Description className="m-auto max-w-[260px] px-(--r2-pad) text-center text-r2-meta text-muted-foreground">
            The conversation for this project is coming in its own prototype.
          </Dialog.Description>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
