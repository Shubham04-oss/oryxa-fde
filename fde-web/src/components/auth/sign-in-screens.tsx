import { useEffect, useRef, useState } from "react"
import {
  AuthForm,
  Field,
  FormError,
  Notice,
  Or,
  PasswordField,
  Secondary,
  StepLink,
  Submit,
} from "./fields"
import { AuthFrame } from "./frame"
import { carried, codeOf, emailProblem, useCall, useFlow, useNote, waitText } from "./flow"
import { LATER, SIGN_IN_TEXT, SignInError, signInApi } from "@/lib/api/sign-in-api"
import { OUTCOMES } from "@/lib/sign-in-outcome"
import type { Outcome } from "@/lib/sign-in-outcome"

// The screens that sign a person in (ADR 0007). Each is plain: a title, its fields, its refusals in
// our own words, and the ways on. The calls are in `sign-in-api.ts`; a way in whose API route is
// still to come (`LATER`) is not shown.

type Props = { returnTo: string }

// What the dev mock accepts, written only into a dev build: `import.meta.env.DEV` is `false` in a
// production build, so these strings are dropped from it.
const SAMPLES = import.meta.env.DEV
  ? "Sign in as riya@example.com with sample-password. Also try two-orgs@, unverified@, no-org@, mfa@ and locked@example.com."
  : undefined
const SAMPLE_CODE = import.meta.env.DEV ? "The code is 123456." : undefined

/**
 * A refusal the person can act on, with the way on where there is one. `restart` offers to start
 * again, on a later step that a refusal has ended.
 */
function Refusal({
  error,
  returnTo,
  restart = false,
}: {
  error: SignInError
  returnTo: string
  restart?: boolean
}) {
  return (
    <FormError>
      {waitText(error)}{" "}
      {restart && error.code === "sign_in_unsupported" && (
        <StepLink step="password" returnTo={returnTo}>
          Start again
        </StepLink>
      )}
      {error.code === "too_many_attempts" && LATER.forgot && (
        <StepLink step="forgot" returnTo={returnTo}>
          Reset your password
        </StepLink>
      )}
    </FormError>
  )
}

/** Email and password, with a code or Google as the other ways in. */
export function PasswordScreen({ returnTo }: Props) {
  const { follow, go, ended } = useFlow(returnTo)
  const { working, error, setError, run } = useCall(ended)
  const note = useNote()
  const [noted, setNoted] = useState(note !== null)
  const [email, setEmail] = useState(carried.email)
  const [password, setPassword] = useState("")
  const [problems, setProblems] = useState<{ email?: string; password?: string }>({})
  const emailField = useRef<HTMLInputElement>(null)
  const passwordField = useRef<HTMLInputElement>(null)

  async function submit() {
    const found = {
      email: emailProblem(email) ?? undefined,
      password: password === "" ? "Enter your password." : undefined,
    }
    setProblems(found)
    setError(null)
    setNoted(false)
    if (found.email) return emailField.current?.focus()
    if (found.password) return passwordField.current?.focus()
    carried.email = email.trim()
    const next = await run(() => signInApi.withPassword(email.trim(), password, returnTo))
    // A refused password is never kept, even in this screen's state.
    setPassword("")
    if (next) follow(next)
    else passwordField.current?.focus()
  }

  return (
    <AuthFrame
      title="Sign in"
      lead="Sign in to your FDE workspace with your work account."
      mockNote={SAMPLES}
    >
      <div className="grid gap-4">
        <AuthForm label="Sign in with email and password" onSubmit={() => void submit()}>
          <Field
            ref={emailField}
            label="Email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            error={problems.email ?? (error?.code === "invalid_email" ? error.message : undefined)}
          />
          <PasswordField
            ref={passwordField}
            label="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={
              problems.password ?? (error?.code === "invalid_password" ? error.message : undefined)
            }
            aside={
              LATER.forgot && (
                <StepLink step="forgot" returnTo={returnTo}>
                  Forgotten password?
                </StepLink>
              )
            }
          />
          {noted && note && <Notice>{SIGN_IN_TEXT[note]}</Notice>}
          {error && !["invalid_email", "invalid_password"].includes(error.code) && (
            <Refusal error={error} returnTo={returnTo} />
          )}
          <Submit working={working} busy="Signing in…">
            Sign in
          </Submit>
        </AuthForm>
        {(LATER.code || LATER.google) && <Or />}
        {LATER.code && (
          <Secondary
            disabled={working}
            onClick={() => {
              carried.email = email.trim()
              go("code")
            }}
          >
            Email me a code instead
          </Secondary>
        )}
        {LATER.google && (
          <Secondary
            disabled={working}
            onClick={() =>
              void run(async () => {
                await signInApi.withGoogle(returnTo)
                return true
              }).then(
                // Only the mock comes back here; the real one has left for Google.
                (back) => back && follow({ next: "done", return_to: returnTo }),
              )
            }
          >
            Continue with Google
          </Secondary>
        )}
      </div>
    </AuthFrame>
  )
}

/** An emailed one-time code: ask for it, then type it. */
export function CodeScreen({ returnTo }: Props) {
  const { follow, ended } = useFlow(returnTo)
  const { working, error, setError, run } = useCall(ended)
  const [email, setEmail] = useState(carried.email)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [problem, setProblem] = useState<string | undefined>()
  const [resent, setResent] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (sentTo) field.current?.focus()
  }, [sentTo])

  async function send(to: string) {
    setResent(false)
    const done = await run(async () => {
      await signInApi.requestCode(to)
      return true
    })
    if (!done) return
    carried.email = to
    if (sentTo) setResent(true)
    setSentTo(to)
  }

  async function ask() {
    const found = emailProblem(email)
    setProblem(found ?? undefined)
    setError(null)
    if (found) return field.current?.focus()
    await send(email.trim())
  }

  async function enter() {
    const digits = codeOf(code)
    setProblem(digits ? undefined : "Enter the 6-digit code from the email.")
    setError(null)
    if (!digits || !sentTo) return field.current?.focus()
    const next = await run(() => signInApi.withCode(sentTo, digits, returnTo))
    if (next) follow(next)
    else field.current?.focus()
  }

  if (!sentTo)
    return (
      <AuthFrame
        title="Sign in with a code"
        lead="We will email you a code to sign in with. No password needed."
        focusTitle
        mockNote={SAMPLES}
      >
        <div className="grid gap-4">
          <AuthForm label="Email me a code" onSubmit={() => void ask()}>
            <Field
              ref={field}
              label="Email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={setEmail}
              error={problem ?? (error?.code === "invalid_email" ? error.message : undefined)}
            />
            {error && error.code !== "invalid_email" && (
              <Refusal error={error} returnTo={returnTo} />
            )}
            <Submit working={working} busy="Sending…">
              Email me a code
            </Submit>
          </AuthForm>
          <StepLink step="password" returnTo={returnTo}>
            Sign in with a password instead
          </StepLink>
        </div>
      </AuthFrame>
    )

  return (
    <AuthFrame
      title="Enter your code"
      lead={
        <>
          If an account uses <strong className="font-medium text-foreground">{sentTo}</strong>, we
          have emailed it a 6-digit code. It works for a few minutes.
        </>
      }
      focusTitle
      mockNote={SAMPLE_CODE}
    >
      <div className="grid gap-4">
        <AuthForm label="Sign in with the code" onSubmit={() => void enter()}>
          <Field
            ref={field}
            label="Code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            value={code}
            onChange={setCode}
            error={problem}
          />
          {error && <Refusal error={error} returnTo={returnTo} />}
          {resent && !error && <Notice>A new code is on its way. Use the newest one.</Notice>}
          <Submit working={working} busy="Signing in…">
            Sign in
          </Submit>
        </AuthForm>
        <Secondary disabled={working} onClick={() => void send(sentTo)}>
          Send a new code
        </Secondary>
        <button
          type="button"
          className="justify-self-start text-[12px] underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            setSentTo(null)
            setCode("")
            setError(null)
            setResent(false)
          }}
        >
          Use a different address
        </button>
      </div>
    </AuthFrame>
  )
}

/** The code emailed to confirm an address, when sign-in says it is not confirmed yet. */
export function VerifyEmailScreen({ returnTo }: Props) {
  const { follow, ended } = useFlow(returnTo)
  const { working, error, setError, run } = useCall(ended)
  const [code, setCode] = useState("")
  const [problem, setProblem] = useState<string | undefined>()
  const [resent, setResent] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  async function submit() {
    const digits = codeOf(code)
    setProblem(digits ? undefined : "Enter the 6-digit code from the email.")
    setError(null)
    setResent(false)
    if (!digits) return field.current?.focus()
    const next = await run(() => signInApi.verifyEmail(digits))
    if (next) follow(next)
    else field.current?.focus()
  }

  async function resend() {
    setResent(false)
    const done = await run(async () => {
      await signInApi.resendVerification()
      return true
    })
    if (done) setResent(true)
  }

  return (
    <AuthFrame
      title="Check your email"
      lead={
        <>
          To confirm the address is yours, we have emailed a 6-digit code to{" "}
          {carried.email ? (
            <strong className="font-medium text-foreground">{carried.email}</strong>
          ) : (
            "your address"
          )}
          .
        </>
      }
      focusTitle
      mockNote={SAMPLE_CODE}
    >
      <div className="grid gap-4">
        <AuthForm label="Confirm your email address" onSubmit={() => void submit()}>
          <Field
            ref={field}
            label="Code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            value={code}
            onChange={setCode}
            error={problem}
          />
          {error && <Refusal error={error} returnTo={returnTo} restart />}
          {resent && !error && <Notice>A new code is on its way. Use the newest one.</Notice>}
          <Submit working={working} busy="Checking…">
            Confirm and sign in
          </Submit>
        </AuthForm>
        {LATER.resend && (
          <Secondary disabled={working} onClick={() => void resend()}>
            Send a new code
          </Secondary>
        )}
        <StepLink step="password" returnTo={returnTo}>
          Start again
        </StepLink>
      </div>
    </AuthFrame>
  )
}

/**
 * One person in several organisations chooses which to work in. The list is the one the last step's
 * answer offered, kept in memory; after a reload it is gone and sign-in starts again.
 */
export function OrganisationScreen({ returnTo }: Props) {
  const { follow, ended } = useFlow(returnTo)
  const { working, error, run } = useCall(ended)
  const [chosen, setChosen] = useState<string | null>(null)
  const [organisations] = useState(() => carried.organisations)

  useEffect(() => {
    if (organisations.length === 0) ended(new SignInError("invalid_sign_in"))
  }, [organisations, ended])

  async function choose(id: string) {
    setChosen(id)
    const next = await run(() => signInApi.chooseOrganisation(id))
    if (next) follow(next)
    else setChosen(null)
  }

  return (
    <AuthFrame
      title="Choose an organisation"
      lead="Your account is in more than one. Choose the one to work in now; to switch later, sign in again."
      focusTitle
    >
      <div className="grid gap-4">
        <ul aria-label="Your organisations" className="grid gap-2">
          {organisations.map((o) => (
            <li key={o.id}>
              <Secondary disabled={working} onClick={() => void choose(o.id)}>
                {chosen === o.id ? `Opening ${o.name}…` : o.name}
              </Secondary>
            </li>
          ))}
        </ul>
        {error && <Refusal error={error} returnTo={returnTo} restart />}
        <StepLink step="password" returnTo={returnTo}>
          Use a different account
        </StepLink>
      </div>
    </AuthFrame>
  )
}

/**
 * A sign-in that ended with no session: not in an organisation yet, or a step we cannot take yet
 * (MFA, SSO). There is nothing to sign out of, so the way on is back to sign in.
 */
export function OutcomeScreen({ outcome, returnTo }: Props & { outcome: Outcome }) {
  const { title, text } = OUTCOMES[outcome]
  return (
    <AuthFrame title={title} lead="Nothing has been signed in." focusTitle>
      <div className="grid gap-4">
        {outcome === "no_organisation" ? (
          <ol className="grid list-decimal gap-2 pl-5 text-[13px] leading-normal">
            <li>Ask an admin at your organisation to invite you.</li>
            <li>Open the invite email and follow its link to join.</li>
            <li>Sign in again with the same account.</li>
          </ol>
        ) : (
          <p className="text-[13px] leading-normal">{text}</p>
        )}
        <StepLink step="password" returnTo={returnTo} button>
          Back to sign in
        </StepLink>
      </div>
    </AuthFrame>
  )
}
