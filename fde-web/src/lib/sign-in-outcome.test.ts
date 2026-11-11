import { describe, expect, it } from "vitest"
import { outcomeOf } from "./sign-in-outcome"

describe("outcomeOf", () => {
  it("reads only the outcomes it knows", () => {
    expect(outcomeOf("no_organisation")).toBe("no_organisation")
    expect(outcomeOf("mfa_required")).toBe("mfa_required")
    for (const odd of ["", "toString", "__proto__", "<b>x</b>", 1, null, undefined])
      expect(outcomeOf(odd)).toBeUndefined()
  })
})
