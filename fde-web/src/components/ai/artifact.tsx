// From Vercel AI Elements' `artifact.tsx` (vercel/ai-elements at ca8be60), Apache-2.0,
// LICENSE-ai-elements.txt. Changed: our tokens, our Button, Icon and Base UI tooltip. The shell of the
// right panel: one block at full size.
import type { ComponentProps, HTMLAttributes } from "react"
import { Icon } from "../ui/icon"
import { Tip } from "../ui/tooltip"
import { cn } from "@/lib/utils"

export const Artifact = ({ className, ...props }: HTMLAttributes<HTMLElement>) => (
  <section
    className={cn("flex min-h-0 flex-col overflow-hidden bg-canvas", className)}
    {...props}
  />
)

export const ArtifactHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-start justify-between gap-3 border-b px-5 py-3.5", className)}
    {...props}
  />
)

export const ArtifactTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn("text-body font-semibold text-foreground", className)} {...props} />
)

export const ArtifactDescription = ({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-meta text-muted-foreground", className)} {...props} />
)

export const ArtifactActions = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-none items-center gap-1", className)} {...props} />
)

export function ArtifactClose({
  label = "Close",
  ...props
}: ComponentProps<"button"> & { label?: string }) {
  return (
    <Tip label={label} keys={["Esc"]}>
      <button
        type="button"
        aria-label={label}
        className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
        {...props}
      >
        <Icon name="close" size={15} />
      </button>
    </Tip>
  )
}

export const ArtifactContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />
)
