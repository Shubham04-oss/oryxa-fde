// From Vercel AI Elements' `shimmer.tsx` (vercel/ai-elements at ca8be60), Apache-2.0,
// LICENSE-ai-elements.txt. Changed: CSS keyframes (`animate-shimmer` in styles.css) instead of the
// `motion` package, and off under reduced motion, where it is plain muted text.
import { cn } from "@/lib/utils"

export function Shimmer({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "text-muted-foreground motion-safe:animate-shimmer motion-safe:bg-[linear-gradient(90deg,var(--text-muted)_0%,var(--text-muted)_40%,var(--text)_50%,var(--text-muted)_60%,var(--text-muted)_100%)] motion-safe:bg-size-[250%_100%] motion-safe:bg-clip-text motion-safe:text-transparent",
        className,
      )}
    >
      {children}
    </span>
  )
}
