import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router"
import { QuickSwitch, useJumpShortcut } from "./quick-switch"
import type { SwitchTarget } from "./quick-switch"
import { api, queries } from "@/lib/api/client"
import type { CompanySummary, Me } from "@/lib/api/schemas"
import { applyTheme, nextTheme, readTheme } from "@/lib/theme"
import { newWorkspace } from "@/lib/workspace/flag"
import type { Theme } from "@/lib/theme"
import { Icon } from "@/components/ui/icon"

const THEME_LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" }
const THEME_ICON = { system: "system", light: "sun", dark: "moon" } as const

/** Where the FDE's choice of a collapsed sidebar is kept, in this browser. */
const SIDEBAR_KEY = "fde.sidebar"

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed"
  } catch {
    return false
  }
}

function keepCollapsed(collapsed: boolean) {
  try {
    if (collapsed) window.localStorage.setItem(SIDEBAR_KEY, "collapsed")
    else window.localStorage.removeItem(SIDEBAR_KEY)
  } catch {
    // Storage may be unavailable; the sidebar still works.
  }
}

/** Up to two initials: "Riya Kapoor" is "RK". */
export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className="app-avatar" aria-hidden="true">
      {initials(name)}
    </span>
  )
}

/** The header's title: the screen, or the company or project it shows. */
function useTitle(companies: Array<CompanySummary> | undefined) {
  const params: { companyId?: string; projectId?: string; runId?: string } = useParams({
    strict: false,
  })
  const pathname = useLocation({ select: (location) => location.pathname })
  const company = companies?.find((c) => c.id === params.companyId)
  if (params.runId) return "Agent run"
  if (params.projectId)
    return company?.projects.find((p) => p.id === params.projectId)?.name ?? "Project"
  if (params.companyId) return company?.name ?? "Company"
  if (pathname === "/today") return "Today"
  if (pathname === "/new-company") return "New company"
  return pathname === "/" && newWorkspace() ? "Home" : "Companies"
}

/**
 * The workspace (DESIGN.md §2): one sidebar and one central canvas. The sidebar is the only
 * navigation; on a desktop it collapses to an icon rail, on a phone it is an overlay.
 */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const companies = useQuery(queries.companies())
  const [isMobile, setIsMobile] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [profileError, setProfileError] = useState("")
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  const title = useTitle(companies.data?.companies)
  const expanded = isMobile || !collapsed
  const workspace = newWorkspace()

  // Read after mount: the server render has no localStorage, so it always starts at "system".
  const [theme, setThemeState] = useState<Theme>("system")
  useEffect(() => setThemeState(readTheme()), [])

  useEffect(() => {
    const media = window.matchMedia("(max-width: 800px)")
    function sync() {
      setIsMobile(media.matches)
      if (!media.matches) setMobileNavOpen(false)
    }
    sync()
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])

  // A phone's navigation closes behind any selection.
  useEffect(() => {
    setMobileNavOpen(false)
    setMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    if (mobileNavOpen) sidebarToggle.current?.focus()
  }, [mobileNavOpen])

  useEffect(() => {
    if (!menuOpen && !mobileNavOpen) return
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (menuOpen) setMenuOpen(false)
      else closeMobileNav()
    }
    window.addEventListener("keydown", onEscape)
    return () => window.removeEventListener("keydown", onEscape)
  }, [menuOpen, mobileNavOpen])

  const openJump = useCallback(() => {
    setMobileNavOpen(false)
    setJumpOpen(true)
  }, [])
  useJumpShortcut(openJump)

  function closeMobileNav() {
    setMobileNavOpen(false)
    menuButton.current?.focus()
  }

  function toggleCollapsed() {
    setCollapsed((current) => {
      keepCollapsed(!current)
      return !current
    })
  }

  function jumpTo(target: SwitchTarget) {
    if (target.kind === "company")
      void navigate({ to: "/companies/$companyId", params: { companyId: target.company.id } })
    else
      void navigate({
        to: "/companies/$companyId/projects/$projectId",
        params: { companyId: target.company.id, projectId: target.project.id },
      })
  }

  async function signOut() {
    setSigningOut(true)
    setProfileError("")
    try {
      await api.signOut()
      // Every cached read belonged to the session just ended.
      queryClient.clear()
      await navigate({ to: "/sign-in", search: { return_to: "/" } })
    } catch {
      setProfileError("Couldn't sign out. Try again.")
      setSigningOut(false)
    }
  }

  const toggleLabel = isMobile
    ? "Close navigation"
    : collapsed
      ? "Expand sidebar"
      : "Collapse sidebar"

  return (
    <div className="app-shell" data-sidebar={!isMobile && collapsed ? "collapsed" : "expanded"}>
      {(!isMobile || mobileNavOpen) && (
        <aside id="app-navigation" className="app-sidebar" aria-label="Workspace navigation">
          <div className="app-sidebar-top">
            {expanded && (
              <span className="app-org" title={me.organisation.name}>
                {me.organisation.name}
              </span>
            )}
            <button
              className="app-icon-button app-sidebar-toggle"
              type="button"
              ref={sidebarToggle}
              aria-label={toggleLabel}
              title={toggleLabel}
              aria-controls="app-navigation"
              aria-expanded={isMobile ? true : !collapsed}
              onClick={isMobile ? closeMobileNav : toggleCollapsed}
            >
              <Icon name={isMobile ? "close" : "sidebar"} size={17} strokeWidth={1.7} />
            </button>
          </div>

          <button
            className="app-jump"
            type="button"
            aria-label="Jump to a company or project"
            aria-keyshortcuts="Control+K Meta+K"
            title={expanded ? undefined : "Jump to (Ctrl K)"}
            onClick={openJump}
          >
            <Icon name="search" size={16} strokeWidth={1.7} aria-hidden="true" />
            {expanded && (
              <>
                <span>Jump to</span>
                <kbd>Ctrl K</kbd>
              </>
            )}
          </button>

          <nav className="app-nav" aria-label="Main">
            {workspace && (
              <Link
                to="/"
                activeOptions={{ exact: true }}
                className="app-nav-item"
                aria-label={expanded ? undefined : "Home"}
                title={expanded ? undefined : "Home"}
              >
                <Icon name="home" size={17} strokeWidth={1.7} />
                {expanded && <span className="app-nav-label">Home</span>}
              </Link>
            )}
            <Link
              to="/today"
              className="app-nav-item"
              aria-label={expanded ? undefined : "Today"}
              title={expanded ? undefined : "Today"}
            >
              <Icon name="calendar-check" size={17} strokeWidth={1.7} aria-hidden="true" />
              {expanded && <span className="app-nav-label">Today</span>}
            </Link>
            <Link
              to={workspace ? "/companies" : "/"}
              activeOptions={{ exact: true }}
              className="app-nav-item"
              aria-label={expanded ? undefined : "Companies"}
              title={expanded ? undefined : "Companies"}
            >
              <Icon name="building" size={17} strokeWidth={1.7} aria-hidden="true" />
              {expanded && <span className="app-nav-label">Companies</span>}
              {expanded && companies.data && (
                <span className="app-nav-count">{companies.data.companies.length}</span>
              )}
            </Link>
          </nav>

          {expanded && (
            <section className="app-companies" aria-labelledby="app-companies-heading">
              <h2 className="app-companies-heading" id="app-companies-heading">
                Your companies
              </h2>
              {companies.isError && <p className="app-companies-note">Couldn't load them.</p>}
              {companies.data?.companies.length === 0 && (
                <p className="app-companies-note">None yet.</p>
              )}
              <ul>
                {companies.data?.companies.map((company) => (
                  <li key={company.id}>
                    <Link
                      to="/companies/$companyId"
                      params={{ companyId: company.id }}
                      className="app-nav-item"
                    >
                      <span className="app-nav-label">{company.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="app-profile-area">
            {menuOpen && (
              <div className="app-profile-menu" role="menu" aria-label="User menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const next = nextTheme(theme)
                    applyTheme(next)
                    setThemeState(next)
                  }}
                >
                  <Icon name={THEME_ICON[theme]} size={17} strokeWidth={1.7} /> Theme:{" "}
                  {THEME_LABEL[theme]}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={signingOut}
                  onClick={() => void signOut()}
                >
                  <Icon name="sign_out" size={17} strokeWidth={1.7} />{" "}
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </div>
            )}
            <button
              className="app-profile"
              type="button"
              aria-label="Open user menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Avatar name={me.user.name} />
              {expanded && (
                <>
                  <span className="app-profile-copy">
                    <strong>{me.user.name}</strong>
                    <small>{me.role === "admin" ? "Organisation admin" : "Engineer"}</small>
                  </span>
                  <Icon name="more" size={17} strokeWidth={1.7} />
                </>
              )}
            </button>
          </div>
          {profileError && (
            <p className="app-profile-error" role="alert">
              {profileError}
            </p>
          )}
        </aside>
      )}
      {isMobile && mobileNavOpen && (
        <div className="app-scrim" aria-hidden="true" onClick={closeMobileNav} />
      )}

      <div className="app-middle">
        <header className="app-header">
          <div className="app-header-start">
            {isMobile && (
              <button
                className="app-icon-button"
                type="button"
                ref={menuButton}
                aria-label="Open navigation"
                aria-controls="app-navigation"
                aria-expanded={mobileNavOpen}
                onClick={() => setMobileNavOpen(true)}
              >
                <Icon name="menu" size={17} strokeWidth={1.7} />
              </button>
            )}
          </div>
          <h1 title={title}>{title}</h1>
        </header>
        <main className="app-canvas" aria-label={`${title} canvas`}>
          {children}
        </main>
      </div>

      <QuickSwitch open={jumpOpen} onOpenChange={setJumpOpen} onSelect={jumpTo} />
    </div>
  )
}
