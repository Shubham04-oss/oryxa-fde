// From shadcn/ui's base-nova `marker` (shadcn-ui/ui at e62c943), MIT, LICENSE-shadcn.md. Changed: our
// type tokens and a `tone` for the one status a line may carry. A marker is one plain line in the
// thread: a notice, a refusal, a stop. Its words are fixed per code, never the model's.
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

export const markerVariants = cva(
  "group/marker relative flex min-h-4 w-full items-start gap-2 text-left text-meta text-muted-foreground",
  {
    variants: {
      variant: {
        default: "",
        separator:
          "items-center before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-border",
      },
      tone: {
        quiet: "",
        attention: "[&_[data-slot=marker-icon]]:text-attention",
        error: "[&_[data-slot=marker-icon]]:text-destructive",
      },
    },
    defaultVariants: { variant: "default", tone: "quiet" },
  },
)

export function Marker({
  className,
  variant,
  tone,
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof markerVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn(markerVariants({ variant, tone }), className) },
      props,
    ),
    render,
    state: { slot: "marker" },
  })
}

export function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-icon"
      aria-hidden="true"
      className={cn("mt-px grid size-4 shrink-0 place-items-center", className)}
      {...props}
    />
  )
}

export function MarkerContent({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-content"
      className={cn("min-w-0 wrap-break-word", className)}
      {...props}
    />
  )
}
