// From Vercel AI Elements' `confirmation.tsx` (vercel/ai-elements at ca8be60), Apache-2.0,
// LICENSE-ai-elements.txt. Changed: a section on our tokens instead of shadcn's Alert, and the AI SDK's
// approval states read from our proposal phase (`chat.ts`), with two the SDK has no word for: being
// confirmed, and refused by the API.
import type { ComponentProps, ReactNode } from "react"
import { createContext, useContext } from "react"
import type { ProposalPhase } from "@/lib/workspace/chat"
import { cn } from "@/lib/utils"

type Approval =
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied"

/** Our phase as the AI SDK's tool approval state, so these parts line up with AI Elements'. */
export const APPROVAL: Record<ProposalPhase, Approval> = {
  waiting: "approval-requested",
  confirming: "approval-responded",
  done: "output-available",
  refused: "output-error",
  dismissed: "output-denied",
}

const ConfirmationContext = createContext<ProposalPhase>("waiting")

export function Confirmation({
  phase,
  className,
  ...props
}: ComponentProps<"section"> & { phase: ProposalPhase }) {
  return (
    <ConfirmationContext.Provider value={phase}>
      <section
        data-slot="confirmation"
        data-state={APPROVAL[phase]}
        className={cn("grid gap-3 rounded-[14px] border bg-canvas px-4 py-3.5", className)}
        {...props}
      />
    </ConfirmationContext.Provider>
  )
}

const when = (phases: Array<ProposalPhase>) =>
  function Shown({ children }: { children?: ReactNode }) {
    return phases.includes(useContext(ConfirmationContext)) ? children : null
  }

/** Shown while it waits on the person, or while it is being confirmed. */
export const ConfirmationRequest = when(["waiting", "confirming"])
export const ConfirmationAccepted = when(["done"])
export const ConfirmationRefused = when(["refused"])
export const ConfirmationRejected = when(["dismissed"])

export function ConfirmationActions({ className, ...props }: ComponentProps<"div">) {
  const phase = useContext(ConfirmationContext)
  if (phase !== "waiting" && phase !== "confirming" && phase !== "refused") return null
  return <div className={cn("flex flex-wrap items-center gap-2", className)} {...props} />
}
