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
- **Dialogs.** A launcher (**Jump to**) sits 12vh from the top, like a command palette. A form or a
  prompt (New task, Edit task, the Blocked and Waiting questions) is centred on the screen: 560px
  wide at most, 16px from every edge, scrolling inside itself when it is taller than the screen.
  Both sit on a scrim and close with Escape.
- **Jump to** is a Base UI dialog: type to filter companies and projects (every word must match the
  company or project name), arrows to move (wrapping), Enter to open, Escape to close.

## 3. Screens

- **Sign-in.** The one expressive screen: the full canvas, a compact card inset right, and the
  eight stages beside it, each a little stronger than the last. Continue goes to AuthKit's hosted
  page through the API (`/auth/login`), which brings the FDE back to where they were. On the mock
  it says that no account is checked.
- **Companies (home).** Two cards per row (one below 960px): name, industry and the FDE's part
  (Lead, Engineer, or Organisation admin when they reach it as one), each project with its stage,
  and what needs the FDE there today.
- **Today.** An inbox: three cards in an 880px column, **Blocked** (blocked tasks, denied or revoked
  access), **Due** (open tasks due today or overdue, oldest first) and **Waiting on the customer**
  (tasks waiting on the customer, open access requests, longest wait first). Each item appears
  once: blocked wins over waiting, waiting over due. A row says what it is, where it is (company
  and project) and why it is there, and **acts in place**. The agent runs card follows.
  - **One action per row, the rest in a menu.** The button is the move most likely wanted for
    why the row is there; the row's menu (the round dots button) holds the rest and **Open project**.
    Due: **Done**. Blocked task: **Unblock** (to In progress: the blocker is gone, so work resumes).
    Waiting task: **Got it** (to In progress: the customer answered). A due task that is not yet
    started finds **Start** in its menu. The menu also has, for a task, **Mark done**, **Mark
    blocked…**, **Waiting on the customer…** and **Back to to do** (minus the status it is in).
    Those are the board's five moves, from the same code (`useTaskMover`, `MoveAsk`, `board.ts`).
  - **Access request rows** change status through `PUT .../access-requests/{id}`, which replaces the
    request, so everything but the status is sent as it was. The API puts no limit on which status
    follows which. Open (requested, in progress): **Granted**, with **Mark in progress**,
    **Mark denied** and **Back to requested** in the menu. Denied or revoked: **Ask again** (back to
    requested, which moves it under Waiting), with **Mark in progress** and **Mark granted**. A
    granted request leaves Today, and the API's rules put the tasks blocked on it back to do, so
    Today reads again a few seconds later.
  - **The two prompts are the board's.** Into Blocked asks what is blocking it (required); into
    Waiting on the customer asks who, from the project's stakeholders, read when the prompt opens.
  - **Honest saving, as on the board.** A row that is saving stays where it is, dimmed, its reason
    line saying "Moving to Done…" (the line count does not change, so nothing shifts) and its buttons
    off. It leaves or changes group only when the API answers, and a read of Today sent before the
    write cannot bring it back. A refused action leaves the row where it was and says why in the row,
    in red, with Dismiss. A dialog that fails stays open with its reason.
  - **Keys.** The row is one stop for Tab (its link, its button and its menu; every other row is
    skipped, so sixty rows are not sixty stops). **J** and **K**, or the arrows once a row has
    focus, move between rows; **Enter** on a row opens the project; **E** does the row's main action;
    **M** opens its menu, on its first entry. Nothing is taken while a field, dialog or menu has
    focus, with Ctrl, Cmd, Alt or Shift held, or by the arrows before any row has focus (they
    still scroll the page). The keys are shown in a quiet line above the groups (hidden on touch)
    and **E** shows on the focused row's button. A click anywhere on a row but its buttons opens the
    project.
  - **Focus after an action** moves to the row that followed it (the one before, when it was last)
    once the API confirms, so the keyboard can work down the list. It waits for a prompt to close
    and does not take focus from someone who has moved elsewhere.
  - **What is left.** The line above the groups counts everything and says where: "20 need you
    across 5 companies: 5 blocked, 6 due, 9 waiting on the customer." Groups with none are left out
    of the parts. "Nothing needs you today." appears only when the API has answered and every group
    is empty; the three cards stay, each saying what is not there, so the page does not change
    shape as the last row goes.
  - **Phones.** The button and menu sit beside the text, at 36px, and the key hints are not shown.
  - Signals from other tools (ADR 0006) will be more row kinds: a row is a `TodayItem`, its actions
    come from `actionsOf` (`src/lib/today.ts`), and `TodayRow` draws any of them.
- **Company.** Profile (summary, industry, region and the FDE's part), then Stakeholders (with
  their part) and Systems (with their kind) side by side (stacked below 960px), then Projects.
- **Project.** The company link, the summary, the stage bar, the **Board** (the one card that
  takes the canvas's full width, up to 1600px; the others stay in the 1040px page column), Scope beside Success
  criteria (each with its target), then Access and Decisions. Scope says whether it is signed off,
  changed since sign-off, or not signed off. Access and waiting tasks name people and systems from
  the company's records.
- **Board (project).** The project's tasks, one column per status: To do, In progress, Waiting on
  the customer, Blocked, Done. It replaces the old Tasks card and sits straight after the stage bar,
  not behind a tab: tasks are what an FDE touches all day, and a tab would hide them behind a
  click on every visit. A card has the title, who has it, why it is stuck (the blocker, or who it
  waits on and for how long) and when it is due; overdue and blocked get the amber dot.
  - **Summary line.** One line above the columns, always visible, says what is stuck, for example
    "1 blocked 1 waiting on the customer 2 overdue" (a part with none is left out; with none at all
    it says nothing is blocked, waiting or overdue). Blocked and overdue carry the amber dot, waiting
    a neutral one. Each part is a button: Blocked and Waiting scroll to that column and focus it;
    Overdue goes to the first late card, in column order. Stuck work is never found only by
    scrolling.
  - **Width.** A column is 220px wide at least. When they all fit they share the width; when not,
    the row scrolls sideways with scroll snap and a visible scrollbar (a classic bar on the tokens,
    not one that hides itself), and each column is sized so that about a third of the next one
    always shows. No gradients or fades. Under 800px the columns stack.
  - **Done is collapsed** to a 56px strip with its dot, name and count (a row on a phone), because
    it is the least urgent column and grows without limit. It is still a drop target and a **Move to**
    destination. Opening it (its heading is the toggle) scrolls it into view and lists the five most
    recently finished tasks, with **Show all** for the rest.
  - **The card's menu button** sits in the card's top right corner. With a mouse it appears on hover
    and on keyboard focus; on touch it is always shown. Either way the title's first line stops short
    of it (and on touch every line does), so a long title stays readable under the button. The rest
    of a title uses the card's full width.
  - **Moving.** Drag a card to another column, or open its menu (the button in the card's corner,
    reachable by Tab and operated with the arrow keys and Enter) and pick **Move to**. The menu is
    the only way on a phone. Dropping on the same column does nothing.
  - **Two moves ask first.** Into **Blocked** asks what is blocking it, and the answer is required.
    Into **Waiting on the customer** asks who, from the company's stakeholders, or "No one in
    particular". Moves to the other columns go straight through, and leaving Blocked or Waiting
    clears the blocker or the person.
  - **A card that is moving cannot be opened.** Its Edit form would show the old status and saving
    it would undo the move. It opens again once the API has answered.
  - **Nothing is shown as saved until the API confirms it.** A moving card stays in its column,
    dimmed and marked "Moving to ...", and jumps only when the API answers. A refused move leaves
    the card where it was and says why above the board, with Dismiss. A dialog that fails stays
    open with its reason and what was typed.
  - **Order** in a column is creation order, except Done, which is the most recently finished first. The API has no position field, so the board does not
    invent one.
  - **Create, edit, delete.** **New task** opens a form: title, status, the blocker or who it waits
    on when the status needs one, due date, and who has it (you, or unassigned). Clicking a card
    opens the same form. **Delete task** asks first. A teammate's name is not known yet, only their
    id, so a task assigned to one says "Assigned to a teammate" and keeps them on save.
- **Agent runs (project).** A card after Access: the project's runs, newest first, each with its
  state, and **Start a task**: what the agent should do and the GitHub repository and branch it
  starts from, prefilled from the latest run. The form checks the repository with the API's own
  rules before it sends.
- **Agent run review.** The task and its state, then **Waiting for approval** while a request is
  open: its title, action and tool, and the full input exactly as it would run. **Approve** and
  **Reject** both ask first: approving runs the action, and rejecting stops the run. On a phone the
  buttons are full width. Then the
  latest plan, the files changed, **Tests and commands** in order with how each ended, and what the
  agent said, ending with its result. A finished run links its pull request (only a github.com pull
  request page); a failed one says why. While a run may change, the screen follows its live output
  and reads it again every few seconds; **Cancel** asks first.
- **Today's runs.** A fourth card: runs that may still need the FDE across every company, waiting
  for approval first.
- **The stage bar.** Eight steps; done steps in `--text-soft`, the current one in `--text`, later
  ones in `--border-quiet`. Only the moves `oryxa_fde_core::Stage::transition` allows are buttons:
  the next stage, or back to any earlier one for rework. Later stages are disabled and say why. A
  move asks first. Four per row on a phone.

## 4. Data

- `src/lib/api/client.ts` is the only way to the API. Screens use `api` and `queries` from it and
  nothing else. Agent runs have their own spec, `crates/oryxa-fde-agent/openapi.json`, generated
  into `agent-runs.gen.ts` and checked the same way; a run's events follow the harness format and
  are parsed one by one (`src/lib/api/runs.ts`), tested on the harness's recorded session. Calls
  go through a client generated from the API's committed spec,
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
- Home, Jump to and Today read whole views from the API (`GET /v1/companies`, `/v1/today`). The
  company and project screens are gathered from a few calls each in `client.ts`; a project's
  people and systems are read through the project, so an assignee may see them.
- Live run output comes over a WebSocket on this app's own origin (`/live/...`). The Worker
  (`src/live.ts`) asks the API whether the session may see the run, then connects it to the run's
  channel in the realtime Worker (`realtime/`) through a service binding; the browser never reaches
  that Worker. Without it the screen reads the run every few seconds instead.
- Pages carry a content security policy with a fresh script nonce per response; static assets get
  their headers from `public/_headers`, kept in step by `security-headers.test.ts`.
- `pnpm dev:mock` answers from `src/dev/mock-api.ts`: the spec's routes in the browser, on
  invented sample data only. Setting `globalThis.__fdeMockFailWrites = true` there (in the console,
  or a test) makes every write answer 503, so the failed-save states can be seen; the switch lives
  in the mock and ships nowhere. It exists only in a dev build with `VITE_FDE_MOCK_API=1`;
  `mock-excluded.test.ts` and CI prove a production build leaves it out. Tests run against the
  same mock.

## 5. Looking at a screen

Every PR that changes a screen is looked at before it goes to review, and lists its screenshots in
the PR text. `pnpm shots` does it in one command: it renders the screens in `scripts/shots/screens.mjs`
on `pnpm dev:mock` (it uses one already running at `http://127.0.0.1:3000`, or starts and stops its own)
at 1440, 1024 and 390 wide, light and dark, and writes PNGs to `<tmpdir>/fde-shots` (`--out DIR` to
choose; `--only NAME[,NAME]` to take some; `--url` for another address). The browser is Playwright's
official Docker image, pinned in `scripts/shots/run.mjs`, run on the host network and removed after; nothing
is installed on the host (Playwright's driver is cached in `~/.cache/fde-shots`) or added to the app, and the script is not in the production build. It needs
Docker, and the image (about 3.6 GB) is pulled the first time. It exits non-zero when a screen fails to
render, and leaves a `-FAILED.png` of it.

- A page is captured whole: the app's own scroll container is grown by what it hides. A screen with an
  overlay open (`full: false`) is the viewport only, as a person would see it.
- 390 wide is a touch device, so hover-only controls are as they are on a phone.
- To add a screen, add an entry to `screens.mjs`: a `name`, a `path`, a `ready` locator that is visible
  once it has rendered, and an optional `act` for what to capture (open a dialog or a menu, hover, type).
  `failWrites: true` makes the mock refuse every write, to see the failed-save states. `sizes` and
  `themes` narrow an entry. The file's header lists every option.
- Look at the shots, in both themes and at 390 wide, before asking for review; say in the PR what you
  checked and what you changed because of it.

## 6. States and copy

- Every read shows loading, empty and error states; errors offer Try again. Today never claims an
  all clear unless the API answered.
- Never imply a connection or a finished action before the API confirms it. A write is never
  applied to the screen first and undone on failure: the screen shows it pending, then confirmed.
- Plain, short sentences in sentence case. No em dashes anywhere: UI copy, docs and comments. No
  exclamation marks.
