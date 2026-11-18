import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import type { components } from "./fde-api.gen"
import * as S from "./schemas"

type Spec = components["schemas"]

describe("schemas", () => {
  // Checked by `pnpm typecheck`: when the spec changes, `pnpm api:generate` changes these types
  // and the schemas must follow before the app builds again.
  it("accept exactly what the OpenAPI spec says each answer is", () => {
    expectTypeOf<z.input<typeof S.Me>>().toEqualTypeOf<Spec["MeOut"]>()
  })

  it("refuse ids that break the platform's id rule", () => {
    for (const bad of ["", "a|b", "a b", "a/b", "é", "../x", "a".repeat(65)])
      expect(S.UserId.safeParse(bad).success, bad).toBe(false)
    expect(S.UserId.safeParse("user_01J-x").success).toBe(true)
  })

  it("fail loudly on an answer that drifts from the contract", () => {
    const me = {
      user: { id: "user_1", name: "Riya Kapoor" },
      organisation: { id: "org_1", name: "Sample Org" },
      role: "admin",
    }
    expect(S.Me.safeParse(me).success).toBe(true)
    expect(S.Me.safeParse({ ...me, role: "owner" }).success).toBe(false)
    expect(S.Me.safeParse({ ...me, user: { id: "../x", name: "n" } }).success).toBe(false)
  })
})
