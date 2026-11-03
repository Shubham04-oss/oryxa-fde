import { beforeEach, describe, expect, it } from "vitest"
import { applyTheme, nextTheme, readTheme, themeBootScript } from "./theme"

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute("data-theme")
  })

  it("cycles system, light, dark", () => {
    expect(nextTheme("system")).toBe("light")
    expect(nextTheme("light")).toBe("dark")
    expect(nextTheme("dark")).toBe("system")
  })

  it("remembers light and dark; system clears both", () => {
    applyTheme("dark")
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
    expect(readTheme()).toBe("dark")
    applyTheme("system")
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
    expect(readTheme()).toBe("system")
  })

  it("ignores junk in storage, and the boot script applies only known values", () => {
    localStorage.setItem("fde.theme", "neon")
    expect(readTheme()).toBe("system")
    new Function(themeBootScript)()
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
    localStorage.setItem("fde.theme", "dark")
    new Function(themeBootScript)()
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
  })
})
