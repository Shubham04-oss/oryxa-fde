import { act } from "@testing-library/react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { AuthForm, Field, PasswordField, Submit } from "./fields"

function Form() {
  return (
    <AuthForm label="Sign in with email and password" onSubmit={() => {}}>
      <Field label="Email" name="email" type="email" autoComplete="username" value="" />
      <PasswordField label="Password" name="password" autoComplete="current-password" value="" />
      <Submit working={false} busy="Signing in…">
        Sign in
      </Submit>
    </AuthForm>
  )
}

describe("a sign-in form before the page's script runs", () => {
  it("is served with its submit button disabled, so it cannot be sent natively", () => {
    const container = document.createElement("div")
    container.innerHTML = renderToString(<Form />)

    const submit = container.querySelector<HTMLButtonElement>("button[type=submit]")
    expect(submit).not.toBeNull()
    expect(submit!.disabled).toBe(true)
    expect(container.querySelector("form")!.getAttribute("method")).toBe("post")
  })

  it("enables the button once React has hydrated the page", async () => {
    // Hydration warns about nothing here; a mismatch would log.
    const errors = vi.spyOn(console, "error")
    const container = document.createElement("div")
    container.innerHTML = renderToString(<Form />)
    document.body.appendChild(container)
    const submit = container.querySelector<HTMLButtonElement>("button[type=submit]")!
    expect(submit.disabled).toBe(true)

    let root: ReturnType<typeof hydrateRoot> | undefined
    await act(async () => {
      root = hydrateRoot(container, <Form />)
    })

    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(false)
    expect(errors).not.toHaveBeenCalled()
    act(() => root!.unmount())
    container.remove()
  })
})
