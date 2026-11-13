// From shadcn/ui's base-nova `bubble` (shadcn-ui/ui at e62c943), MIT, LICENSE-shadcn.md. Changed: two
// variants on our tokens (`muted` for what the person said, `ghost` for the reply), no reactions.
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const bubbleVariants = cva(
  "group/bubble relative flex w-fit max-w-[85%] min-w-0 flex-col gap-1 data-[align=end]:self-end data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        muted: "*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-card",
        ghost:
          "*:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:border-0 *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0",
      },
    },
    defaultVariants: { variant: "muted" },
  },
)

export function Bubble({
  variant = "muted",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  )
}

/** Plain text only: `white-space: pre-wrap`, never markdown or HTML. */
export function BubbleContent({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "w-fit max-w-full min-w-0 rounded-[14px] border px-3.5 py-2 text-body wrap-break-word whitespace-pre-wrap",
          className,
        ),
      },
      props,
    ),
    render,
    state: { slot: "bubble-content" },
  })
}
