import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  if (typeof window === "undefined") return
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState(null, "", "/")
})

if (typeof window !== "undefined") {
  // Node 25+ has `localStorage` and `sessionStorage` globals of its own (undefined without a
  // flag) that hide jsdom's; put jsdom's back.
  const { jsdom } = globalThis as unknown as { jsdom?: { window: Window } }
  for (const name of ["localStorage", "sessionStorage"] as const)
    if (jsdom && typeof window[name] === "undefined")
      Object.defineProperty(globalThis, name, { value: jsdom.window[name], configurable: true })

  // jsdom has no matchMedia; the shell's phone check needs it.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
  // jsdom has no scrolling: Jump to keeps its active result in view, the router restores scroll.
  Element.prototype.scrollIntoView = () => {}
  window.scrollTo = () => {}
}
