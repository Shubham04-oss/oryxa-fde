/**
 * How a sign-in ended without a session, as `/sign-in?error=…` says it: `/auth/callback` redirects
 * there (no organisation since #202; the rest with ADR 0007), and so do our own screens. Read with or
 * without the own-sign-in flag.
 */
export const OUTCOMES = {
  no_organisation: {
    title: "Your account is not part of an organisation yet",
    text: "Ask an admin at your organisation to invite you to the FDE workspace, then sign in again.",
  },
  mfa_required: {
    title: "We could not finish signing you in",
    text: "Your account asks for a second sign-in step, which the FDE workspace does not support yet. Ask your organisation's admin for help.",
  },
  sso_required: {
    title: "We could not finish signing you in",
    text: "Your organisation signs in through its own single sign-on, which the FDE workspace does not support yet. Ask your organisation's admin for help.",
  },
  cannot_finish: {
    title: "We could not finish signing you in",
    text: "This sign-in needs a step the FDE workspace does not support yet. Ask your organisation's admin for help.",
  },
} as const
export type Outcome = keyof typeof OUTCOMES

export function outcomeOf(value: unknown): Outcome | undefined {
  return typeof value === "string" && Object.hasOwn(OUTCOMES, value)
    ? (value as Outcome)
    : undefined
}
