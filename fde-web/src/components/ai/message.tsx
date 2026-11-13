// From shadcn/ui's base-nova `message` (shadcn-ui/ui at e62c943), MIT, LICENSE-shadcn.md. Changed: our
// type tokens, and no avatar or header: a turn is told apart by its layout, not a picture.
import type * as React from "react"
import { cn } from "@/lib/utils"

export function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-2 text-body data-[align=end]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  )
}

export function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex w-full min-w-0 flex-col gap-3 wrap-break-word group-data-[align=end]/message:items-end",
        className,
      )}
      {...props}
    />
  )
}

export function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex max-w-full min-w-0 items-center gap-1 text-meta text-muted-foreground group-data-[align=end]/message:justify-end",
        className,
      )}
      {...props}
    />
  )
}
