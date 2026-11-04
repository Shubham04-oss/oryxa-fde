# FDE web: design contract

The source of truth for how `fde-web/` looks and behaves. It starts from the platform web app's
contract (`Shubham04-oss/oryxa-platform`, `web/DESIGN.md`): one sidebar and one central canvas,
quiet cards, a strictly neutral palette, light and dark. New screens should look like the same
family of products. When a decision changes, update this file in the same PR.

## What differs from the platform

| Platform web                                       | FDE web                                                                          | Why                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Green and red are the only colours                 | Adds `--attention` (amber) for blocked, overdue, failing and denied              | An FDE scans for what is stuck; red stays for errors only              |
| The center is driven by `?view=`                   | Real routes: `/`, `/today`, `/companies/<id>`, `/companies/<id>/projects/<id>`   | Companies and projects are things people link to and share             |
| New chat, Requests, Knowledge, Tools               | Jump to, Today, Companies, and the FDE's companies                               | The FDE moves between customers, not conversations                     |
| Screens in plain CSS per component                 | The shell in `src/shell.css`; screens in Tailwind utilities on the same tokens   | Less CSS to keep in step; one place for the shell                      |
| The gateway mock answers HTTP routes in the Worker | The mock answers the API's routes in the browser, behind `src/lib/api/client.ts` | `dev:mock` needs no Worker or API; the spec's types keep the mock true |
| A pixel cyclone on sign-in                         | The eight stages, fading in                                                      | The product's own shape                                                |

## 1. Colour

Every colour is written once, as a token in `src/styles.css`. Screens read tokens through Tailwind
utilities (`bg-card`, `text-soft`, `border-strong`, `bg-attention`) or `var(--token)` in
`src/shell.css`. Do not write a hex, `rgb()` or `hsl()` anywhere else.

| Token             | Light     | Dark      | Use                                              |
| ----------------- | --------- | --------- | ------------------------------------------------ |
| `--base`          | `#f4f4f4` | `#111111` | Page surround, the sidebar, the header band      |
| `--canvas`        | `#ffffff` | `#1e1e1e` | The central canvas, sign-in, overlays            |
| `--card`          | `#f7f7f7` | `#111111` | Cards on the canvas                              |
| `--raised`        | `#fafafa` | `#242424` | Fields, inner wells, the move confirmation       |
| `--hover`         | `#ebebeb` | `#1d1d1d` | Hover on the base surface only                   |
| `--selected`      | `#e4e4e4` | `#262626` | The current item; hover on the canvas and cards  |
| `--border-quiet`  | `#e6e6e6` | `#353535` | Card, field and divider borders                  |
| `--border-strong` | `#cccccc` | `#555555` | Hovered borders, a status dot with no tone       |
| `--focus`         | `#8c8c8c` | `#d6d6d6` | Keyboard focus ring                              |
| `--text`          | `#111111` | `#f2f2f2` | Titles, body, the primary button                 |
| `--text-soft`     | `#404040` | `#a8a8a8` | Navigation labels, secondary emphasis            |
| `--text-muted`    | `#737373` | `#999999` | Metadata and hints                               |
| `--text-inverse`  | `#ffffff` | `#111111` | Text on the primary button                       |
| `--success`       | `#16a34a` | `#22c55e` | Granted, passing, signed off. Nothing else.      |
| `--attention`     | `#b45309` | `#fbbf24` | Blocked, overdue, failing, denied. Nothing else. |
| `--destructive`   | `#dc2626` | `#f87171` | Errors and destructive actions. Nothing else.    |

- Every grey is neutral (R=G=B). No decorative accent.
- A status is a dot and words, never colour alone.
- Two themes, one set of token names. The theme follows the system by default; the profile menu
  cycles System, Light and Dark, kept in this browser (`src/lib/theme.ts`, key `fde.theme`). An
  inline script in `<head>` applies a saved choice before first paint.
- The primary action is near-black with white text. One primary per area.
- Shadows only on overlays (Jump to, menus, the phone sidebar). No gradients, no blur.
- People are initials in a neutral circle.

## 2. Shell

- The sidebar sits on `--base` with no card. The canvas sits beside it with an 8px gutter at the
  right and bottom, a 16px radius and a quiet border.
- The sidebar, top to bottom: the organisation, **Jump to** (Ctrl K or ⌘ K), **Today**,
  **Companies** (with a count), **Your companies** (one link each), and the profile button whose
  menu holds the theme and **Sign out**.
- On a desktop it collapses to a 48px icon rail, kept in `localStorage` (`fde.sidebar`). At 800px
  and below it is an overlay behind a scrim, opened from the header's round menu button, closed by
  Escape, a tap outside or any navigation.
- The header names what the canvas shows, centered: **Today**, **Companies**, the company's name,
  or the project's name.
- **Jump to** is a Base UI dialog: type to filter companies and projects (every word must match the
  company or project name), arrows to move (wrapping), Enter to open, Escape to close.

## 3. Screens

- **Sign-in.** The one expressive screen: the full canvas, a compact card inset right, and the
  eight stages beside it, each a little stronger than the last. Continue goes to AuthKit's hosted
  page through the API (`/auth/login`), which brings the FDE back to where they were. On the mock
  it says that no account is checked.
- **Companies (home).** Two cards per row (one below 960px): name and the FDE's part (Lead or
  Engineer, when they are a member), each project with its stage, and what needs the FDE there
  today.
- **Today.** Two cards in a 880px column: **Blocked** (blocked tasks, denied or revoked access)
  and **Waiting on the customer** (tasks waiting on the customer, open access requests), oldest
  first in each. Each item appears once, and each row says why it is there: the blocker, who
  refused, how long a request has waited and on whom. There is no Due card until tasks have due
  dates in the API.
- **Company.** Profile (the FDE's part, the project count, when it was added), then Stakeholders
  and Systems side by side (stacked below 960px), then Projects.
- **Project.** The company link, the stage bar, Scope beside Success criteria (each with its
  target), then Access, Tasks and Decisions. Scope says whether it is signed off, changed since
  sign-off, or not signed off. Access names the system and owner from the company's records.
- **The stage bar.** Eight steps; done steps in `--text-soft`, the current one in `--text`, later
  ones in `--border-quiet`. Only the moves `oryxa_fde_core::Stage::transition` allows are buttons:
  the next stage, or back to any earlier one for rework. Later stages are disabled and say why. A
  move asks first. Four per row on a phone.

## 4. Data

- `src/lib/api/client.ts` is the only way to the API. Screens use `api` and `queries` from it and
  nothing else. Calls go through a client generated from the API's committed spec,
  `crates/oryxa-fde-api/openapi.json` (`pnpm api:generate` writes `src/lib/api/fde-api.gen.ts`;
  `pnpm api:check` fails CI when it drifts). Every answer is parsed with zod (`schemas.ts`), and
  `schemas.test.ts` fails the typecheck when a schema stops matching its spec type.
- The browser only calls its own origin. The Worker (`src/server.ts`, `src/forward.ts`) forwards
  `/api/*` without the prefix and `/auth/*` as it is to the API: the `API` VPC binding in a
  deploy, `API_URL` in a dev build only. It refuses a write from another origin (`403 csrf`), and
  answers `503` when it has no way to the API.
- The session is the API's HttpOnly cookie, set after AuthKit. No token is ever in JavaScript or
  browser storage. A 401 on any read or write sends the FDE to sign-in, coming back to the address
  they were at when it happened (`src/lib/session.ts`); `safeReturnTo` keeps that address a path
  on this origin.
- Ids are branded zod types with the platform's id rule (1 to 128 of `[A-Za-z0-9_-]`). Ids from
  the address bar are parsed before any call; a bad one shows "not available".
- Every project call takes a `ProjectScope` (company and project). The API answers 403 for a
  company or project that is not the FDE's and 404 for a missing record; the UI shows both as "not
  available", so it cannot tell "not yours" from "does not exist".
- Screens read whole views (`api.companies`, `company`, `project`, `today`) that `client.ts`
  gathers from the API's per-record endpoints, until the API serves those views itself.
- Pages carry a content security policy with a fresh script nonce per response; static assets get
  their headers from `public/_headers`, kept in step by `security-headers.test.ts`.
- `pnpm dev:mock` answers from `src/dev/mock-api.ts`: the spec's routes in the browser, on
  invented sample data only. It exists only in a dev build with `VITE_FDE_MOCK_API=1`;
  `mock-excluded.test.ts` and CI prove a production build leaves it out. Tests run against the
  same mock.

## 5. States and copy

- Every read shows loading, empty and error states; errors offer Try again. Today never claims an
  all clear unless the API answered.
- Never imply a connection or a finished action before the API confirms it.
- Plain, short sentences in sentence case. No em dashes anywhere: UI copy, docs and comments. No
  exclamation marks.
