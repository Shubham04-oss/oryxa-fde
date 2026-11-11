import { useQuery } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { AuthForm, Field, FormError, Notice, PasswordField, StepLink, Submit } from "./fields"
import { AuthFrame } from "./frame"
import { carried, emailProblem, useCall, useFlow, waitText } from "./flow"
import { SignInError, signInApi } from "@/lib/api/sign-in-api"

// The screens that set a password: a forgotten one, a reset from the emailed link, and joining from
// an invite. The calls are the assumed contract in `sign-in-api.ts`.

type Props = { returnTo: string }

// What the dev mock accepts, written only into a dev build: `import.meta.env.DEV` is `false` in a
// production build, so these strings are dropped from it.
const MOCK_RESET = import.meta.env.DEV
  ? "Any address answers the same. The sample reset link is /sign-in?step=reset&token=reset-sample."
  : undefined
const MOCK_PASSWORD = import.meta.env.DEV
  ? "The mock refuses a password shorter than 10 characters."
  : undefined

/** Asks for a reset link. The answer is the same whether or not the address has an account. */
export function ForgotScreen({ returnTo }: Props) {
  const { working, error, setError, run } = useCall()
  const [email, setEmail] = useState(carried.email)
  const [problem, setProblem] = useState<string | undefined>()
  const [sentTo, setSentTo] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  async function submit() {
    const found = emailProblem(email)
    setProblem(found ?? undefined)
    setError(null)
    if (found) return field.current?.focus()
    const to = email.trim()
    const done = await run(async () => {
      await signInApi.forgotPassword(to)
      return true
    })
    if (done) {
      carried.email = to
      setSentTo(to)
    }
  }

  if (sentTo)
    return (
      <AuthFrame title="Check your email" focusTitle>
        <div className="grid gap-4">
          <Notice>
            If an account uses <strong className="font-medium">{sentTo}</strong>, we have emailed it
            a link to choose a new password. The link works for a limited time.
          </Notice>
          <p className="text-[12px] leading-normal text-muted-foreground">
            Nothing arrived? Check your spam folder, or ask for the link again in a few minutes.
          </p>
          <StepLink step="password" returnTo={returnTo}>
            Back to sign in
          </StepLink>
        </div>
      </AuthFrame>
    )

  return (
    <AuthFrame
      title="Reset your password"
      lead="Enter the address you sign in with. We will email you a link to choose a new password."
      focusTitle
      mockNote={MOCK_RESET}
    >
      <div className="grid gap-4">
        <AuthForm label="Email me a reset link" onSubmit={() => void submit()}>
          <Field
            ref={field}
            label="Email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            error={problem ?? (error?.code === "invalid_email" ? error.message : undefined)}
          />
          {error && error.code !== "invalid_email" && <FormError>{waitText(error)}</FormError>}
          <Submit working={working} busy="Sending…">
            Email me a reset link
          </Submit>
        </AuthForm>
        <StepLink step="password" returnTo={returnTo}>
          Back to sign in
        </StepLink>
      </div>
    </AuthFrame>
  )
}

/** Shown for a link that has expired, was used, or was never ours. */
function ExpiredLink({
  title,
  advice,
  returnTo,
  forgot,
}: {
  title: string
  advice: string
  returnTo: string
  forgot?: boolean
}) {
  return (
    <AuthFrame title={title} focusTitle>
      <div className="grid gap-4">
        <FormError>
          {new SignInError("link_expired").message} {advice}
        </FormError>
        {forgot && (
          <StepLink step="forgot" returnTo={returnTo}>
            Ask for a new link
          </StepLink>
        )}
        <StepLink step="password" returnTo={returnTo}>
          Back to sign in
        </StepLink>
      </div>
    </AuthFrame>
  )
}

/** A new password, from the emailed reset link. */
export function ResetScreen({ returnTo, token }: Props & { token: string }) {
  const { working, error, setError, run } = useCall()
  const [password, setPassword] = useState("")
  const [problem, setProblem] = useState<string | undefined>()
  const [done, setDone] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  if (!token)
    return (
      <ExpiredLink
        title="Choose a new password"
        advice="Ask for a new one."
        returnTo={returnTo}
        forgot
      />
    )
  if (error?.code === "link_expired")
    return (
      <ExpiredLink
        title="Choose a new password"
        advice="Ask for a new one."
        returnTo={returnTo}
        forgot
      />
    )

  async function submit() {
    setProblem(password === "" ? "Choose a password." : undefined)
    setError(null)
    if (password === "") return field.current?.focus()
    const ok = await run(async () => {
      await signInApi.resetPassword(token, password)
      return true
    })
    setPassword("")
    if (ok) {
      carried.token = ""
      setDone(true)
    } else field.current?.focus()
  }

  if (done)
    return (
      <AuthFrame title="Password changed" focusTitle>
        <div className="grid gap-4">
          <Notice>Your new password is set. Sign in with it.</Notice>
          <StepLink step="password" returnTo={returnTo}>
            Sign in
          </StepLink>
        </div>
      </AuthFrame>
    )

  return (
    <AuthFrame
      title="Choose a new password"
      lead="Use one you do not use on any other site. A password manager can make one for you."
      focusTitle
      mockNote={MOCK_PASSWORD}
    >
      <AuthForm label="Choose a new password" onSubmit={() => void submit()}>
        <PasswordField
          ref={field}
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={problem ?? (error?.code === "password_rejected" ? error.message : undefined)}
        />
        {error && error.code !== "password_rejected" && <FormError>{waitText(error)}</FormError>}
        <Submit working={working} busy="Saving…">
          Change password
        </Submit>
      </AuthForm>
    </AuthFrame>
  )
}

/** Joining from an invite: the invited address, a name and a password. */
export function InviteScreen({ returnTo, token }: Props & { token: string }) {
  const invite = useQuery({
    queryKey: ["sign-in", "invite", token],
    queryFn: () => signInApi.invite(token),
    enabled: token !== "",
    retry: false,
    staleTime: Infinity,
  })

  if (!token || (invite.error instanceof SignInError && invite.error.code === "link_expired"))
    return (
      <ExpiredLink
        title="Join your team"
        advice="Ask whoever invited you to send a new invite."
        returnTo={returnTo}
      />
    )
  if (invite.isPending)
    return (
      <AuthFrame title="Join your team" focusTitle>
        <p role="status" className="text-[13px] text-muted-foreground">
          Checking your invite…
        </p>
      </AuthFrame>
    )
  if (invite.isError)
    return (
      <AuthFrame title="Join your team" focusTitle>
        <div className="grid gap-4">
          <FormError>
            {invite.error instanceof SignInError
              ? waitText(invite.error)
              : new SignInError("failed").message}
          </FormError>
          <button
            type="button"
            className="justify-self-start text-[12px] underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => void invite.refetch()}
          >
            Try again
          </button>
        </div>
      </AuthFrame>
    )
  return <InviteForm returnTo={returnTo} token={token} email={invite.data.email} />
}

function InviteForm({ returnTo, token, email }: Props & { token: string; email: string }) {
  const { follow } = useFlow(returnTo)
  const { working, error, setError, run } = useCall()
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [problems, setProblems] = useState<{ name?: string; password?: string }>({})
  const nameField = useRef<HTMLInputElement>(null)
  const passwordField = useRef<HTMLInputElement>(null)

  if (error?.code === "link_expired")
    return (
      <ExpiredLink
        title="Join your team"
        advice="Ask whoever invited you to send a new invite."
        returnTo={returnTo}
      />
    )

  async function submit() {
    const found = {
      name:
        name.trim() === ""
          ? "Enter your name."
          : name.trim().length > 200
            ? new SignInError("invalid_name").message
            : undefined,
      password: password === "" ? "Choose a password." : undefined,
    }
    setProblems(found)
    setError(null)
    if (found.name) return nameField.current?.focus()
    if (found.password) return passwordField.current?.focus()
    carried.email = email
    const next = await run(() => signInApi.acceptInvite(token, name.trim(), password))
    setPassword("")
    if (next) follow(next)
    else passwordField.current?.focus()
  }

  return (
    <AuthFrame
      title="Join your team"
      lead="You have been invited to the FDE workspace. Choose your name and a password to join."
      focusTitle
      mockNote={MOCK_PASSWORD}
    >
      <AuthForm label="Join with this invite" onSubmit={() => void submit()}>
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          readOnly
          hint="The address you were invited at."
        />
        <Field
          ref={nameField}
          label="Your name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={setName}
          error={problems.name ?? (error?.code === "invalid_name" ? error.message : undefined)}
        />
        <PasswordField
          ref={passwordField}
          label="Password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={
            problems.password ?? (error?.code === "password_rejected" ? error.message : undefined)
          }
        />
        {error && !["invalid_name", "password_rejected"].includes(error.code) && (
          <FormError>{waitText(error)}</FormError>
        )}
        <Submit working={working} busy="Joining…">
          Join and sign in
        </Submit>
      </AuthForm>
    </AuthFrame>
  )
}
