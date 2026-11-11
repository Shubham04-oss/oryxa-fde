import { ForgotScreen, InviteScreen, ResetScreen } from "./account-screens"
import type { Step } from "./flow"
import {
  CodeScreen,
  OrganisationScreen,
  OutcomeScreen,
  PasswordScreen,
  VerifyEmailScreen,
} from "./sign-in-screens"
import type { Outcome } from "@/lib/sign-in-outcome"

/** Our own sign-in (ADR 0007): the screen for `step`, behind the `VITE_FDE_OWN_SIGN_IN` flag. */
export function OwnSignIn({
  step,
  outcome,
  returnTo,
  token,
}: {
  step: Step
  /** How a sign-in ended with no session (`?error=`), which wins over any step. */
  outcome?: Outcome
  returnTo: string
  /** The token from an emailed reset or invite link, already out of the address bar. */
  token: string
}) {
  if (outcome) return <OutcomeScreen outcome={outcome} returnTo={returnTo} />
  switch (step) {
    case "code":
      return <CodeScreen returnTo={returnTo} />
    case "verify-email":
      return <VerifyEmailScreen returnTo={returnTo} />
    case "organisation":
      return <OrganisationScreen returnTo={returnTo} />
    case "forgot":
      return <ForgotScreen returnTo={returnTo} />
    case "reset":
      return <ResetScreen returnTo={returnTo} token={token} />
    case "invite":
      return <InviteScreen returnTo={returnTo} token={token} />
    case "password":
      return <PasswordScreen returnTo={returnTo} />
  }
}
