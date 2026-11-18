import { Button } from "./ui/button"
import { ApiError } from "@/lib/api/client"

/** A failed read: what failed, why when the API says, and Try again unless it cannot help. */
export function Failed({
  title,
  error,
  onRetry,
}: {
  title: string
  error: unknown
  onRetry: () => void
}) {
  const said = error instanceof ApiError && error.message !== error.code ? error.message : null
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-[15px] border border-dashed border-strong p-5"
    >
      <strong className="text-[13px] font-semibold text-destructive">{title}</strong>
      <p className="text-xs text-muted-foreground">
        {said ?? "Check your connection and try again."}
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
