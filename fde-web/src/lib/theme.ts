/** The member's theme choice. "system" follows prefers-color-scheme. Kept in this browser only. */
export type Theme = "system" | "light" | "dark"

const KEY = "fde.theme"
const ORDER: Theme[] = ["system", "light", "dark"]

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === "system") root.removeAttribute("data-theme")
  else root.setAttribute("data-theme", theme)
  try {
    if (theme === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

export const nextTheme = (t: Theme): Theme => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]!

/** Runs before first paint (inline in <head>) so a saved dark choice never flashes light. */
export const themeBootScript = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`
