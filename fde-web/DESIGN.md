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
| A pixel cyclone on sign-in                         | The paper page, our mark and one card, as the workspace looks                    | One product from signed out to signed in                               |

## 1. Colour

Every colour is written once, as a token in `src/styles.css`. Screens read tokens through Tailwind
utilities (`bg-card`, `text-soft`, `border-strong`, `bg-attention`) or `var(--token)` in
`src/shell.css`. Do not write a hex, `rgb()` or `hsl()` anywhere else.

| Token             | Light     | Dark      | Use                                                                                                                                                                                                                                                                                                                       |
| ----------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--base`          | `#f4f2ee` | `#121110` | Page surround (paper), the sidebar, the header band, the signed-out page                                                                                                                                                                                                                                                  |
| `--canvas`        | `#fffefc` | `#1a1917` | The central canvas, the sign-in card, overlays, the conversation box                                                                                                                                                                                                                                                      |
| `--card`          | `#f8f7f4` | `#161514` | Cards on the canvas, the summary beside a conversation                                                                                                                                                                                                                                                                    |
| `--raised`        | `#fbfaf7` | `#211f1d` | Fields, inner wells, the move confirmation                                                                                                                                                                                                                                                                                |
| `--hover`         | `#ebe8e2` | `#1f1d1b` | Hover on the base surface only                                                                                                                                                                                                                                                                                            |
| `--selected`      | `#e5e1d9` | `#2a2825` | The current item; hover on the canvas and cards                                                                                                                                                                                                                                                                           |
| `--border-quiet`  | `#e7e3dc` | `#2f2d2a` | Card, field and divider borders                                                                                                                                                                                                                                                                                           |
| `--border-strong` | `#cfc9bf` | `#4b4844` | Hovered borders, a status dot with no tone                                                                                                                                                                                                                                                                                |
| `--focus`         | `#3b54c4` | `#8d9df5` | Keyboard focus ring (the tint)                                                                                                                                                                                                                                                                                            |
| `--text`          | `#1b1a17` | `#f2f0eb` | Titles, body, the primary button                                                                                                                                                                                                                                                                                          |
| `--text-soft`     | `#46423c` | `#bab5ac` | Navigation labels, secondary emphasis                                                                                                                                                                                                                                                                                     |
| `--text-muted`    | `#68635d` | `#96918a` | Metadata, hints, an unchosen radio, an open checklist item's circle, the Never mark                                                                                                                                                                                                                                       |
| `--text-inverse`  | `#fffefc` | `#161514` | Text on the primary button                                                                                                                                                                                                                                                                                                |
| `--tint`          | `#3b54c4` | `#8d9df5` | Our one colour (lapis): focus, the current step, the workspace's voice, "ask first". Never a status.                                                                                                                                                                                                                      |
| `--tint-soft`     | `#eceffa` | `#22263b` | A tinted well: the workspace's mark, a chosen option, a confirmation on sign-in                                                                                                                                                                                                                                           |
| `--success`       | `#15803d` | `#4ade80` | Granted, passing, signed off. Nothing else.                                                                                                                                                                                                                                                                               |
| `--attention`     | `#b45309` | `#fbbf24` | Blocked, overdue, failing, denied, revoked, an access request open for a week or more, a signed-off scope that has changed, a stage move held up by open checklist items, a save held back because the record changed, a criterion that is not met, a result that is out of date, a case that did not pass. Nothing else. |
| `--destructive`   | `#dc2626` | `#f87171` | Errors and destructive actions. Nothing else.                                                                                                                                                                                                                                                                             |

- Contrast is measured, not judged by eye (WCAG 2.2). `--text-muted` is at least 4.5:1 on every
  surface it sits on: light 5.32 on `--base`, 4.56 on `--selected`, 4.86 on `--hover`, 5.90 on
  `--canvas`; dark 6.03, 4.70, 5.37 and 5.62. A control's outline that says something (an unchosen
  radio, an open checklist item, the Never mark) is drawn in `--text-muted`, never `--border-strong`
  (1.6:1 light, 1.9:1 dark), so it reaches 3:1 and more. The tint on `--tint-soft`, a chosen
  option, is 5.63:1 light and 5.87:1 dark.
- Warm paper and ink, not pure greys: every neutral leans a little warm, the same in both themes.
  One colour of our own, `--tint`, used sparingly; no other decorative colour, no gradients.
- A status is a dot and words, never colour alone.
- Two themes, one set of token names. The theme follows the system by default; the profile menu
  cycles System, Light and Dark, kept in this browser (`src/lib/theme.ts`, key `fde.theme`). An
  inline script in `<head>` applies a saved choice before first paint.
- The primary action is ink with paper text. One primary per view.
- Shadows on overlays (`--shadow`), and one soft lift (`--lift`, `shadow-lift`) for the thing a
  screen is for: the conversation box, the card a question is answered in, the sign-in card.
- People are initials in a neutral circle (someone with no name to show is the outline of a person);
  a company is its first letter on a quiet tile.

### Type, radius, motion and icons

The workspace's screens (the welcome screen, the conversation, sign-in) use only these, from
`@theme` in `src/styles.css`. Older screens move to them as they are rebuilt.

| Token          | Size / line | Use                                    |
| -------------- | ----------- | -------------------------------------- |
| `text-micro`   | 11 / 16     | Labels, metadata, a step's stage       |
| `text-meta`    | 12 / 18     | Hints, secondary lines, small controls |
| `text-body`    | 14 / 22     | Body text, fields, answers             |
| `text-lead`    | 16 / 26     | The conversation box                   |
| `text-title`   | 20 / 28     | A question in the conversation         |
| `text-display` | 30 / 38     | The greeting (26 / 32 on a phone)      |

- `cn()` (`src/lib/utils.ts`) knows these sizes: without that, tailwind-merge took `text-meta` beside
  a text colour for a colour and dropped it.
- Spacing is the 4px scale, in these steps only: 4, 8, 12, 16, 24, 32, 48, 56. A column of the
  workspace is 680px (the welcome screen) or 1120px with its summary; 16px gutters on a phone.
- Radius: `rounded-field` (12px) for fields and choices, `rounded-card` (18px) for cards, 24px for
  the sign-in card and a sheet, and every button is a pill.
- Motion: `animate-rise` (a new turn, 240ms) and `animate-settle` (a card or a filled block,
  320ms) on `--ease-calm`; a reordered plan step glides to its place. Every use is `motion-safe:`,
  so none of it runs under `prefers-reduced-motion`. Buttons press in by 3%; that too is
  `motion-safe:`.
- States: every control has hover (a stronger border or `--selected`), focus (`--focus`, a 2px
  outline or a 4px soft ring of the tint on fields), pressed and disabled (45% opacity).
- Icons come only through `components/ui/icon.tsx` (`<Icon name="…" />`): Pikaicons' free set
  (`@pikaicons/react` and `@pikaicons/core-free`, MIT, pinned), with lucide only where the free set
  has nothing (today a bare tick). Never commit Pikaicons' paid files.

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
  prompt (New task, Edit task, the Blocked and Waiting questions, and the company, project, stakeholder,
  system, scope, access request, decision and note forms) is centred on the screen: 560px
  wide at most (the note form, made for writing, is 720px), 16px from every edge, scrolling inside
  itself when it is taller than the screen.
  Both sit on a scrim and close with Escape.
- **Jump to** is a Base UI dialog: type to filter companies and projects (every word must match the
  company or project name), arrows to move (wrapping), Enter to open, Escape to close.

## 3. Screens

- **Sign-in.** The paper page with our mark at the top and one card in the middle
  (`AuthPage` in `components/auth/frame.tsx`), the same frame as every step of our own sign-in.
  Continue goes to AuthKit's hosted
  page through the API (`/auth/login`), which brings the FDE back to where they were. On the mock
  it says that no account is checked. `/sign-in?error=no_organisation` (from `/auth/callback`) says
  the account is not part of an organisation yet and to ask an admin for an invite, above Continue.
- **Our own sign-in (ADR 0007),** behind the build flag `VITE_FDE_OWN_SIGN_IN=1`, off until the API's
  sign-in routes are deployed. Every step is `/sign-in?step=…` in the same frame
  (`components/auth/frame.tsx`; fields in `fields.tsx`, so a restyle starts in those two): email and
  password, then "or" and **Email me a code** as its own full-width choice (with an address typed it
  asks for the code at once and opens on typing it, so a person with no password signs in with a
  code alone), and "Continue with Google"; the code (ask, then enter, with **Send a new code**);
  verify your email (with **Send a new code**); choose an organisation (the API's list, from the pending step, so Google's
  callback lands on it too); forgotten and reset password; accept an invite. An end with no session
  is `/sign-in?error=…`: not in an organisation yet, or a step we cannot take yet (MFA, SSO), each
  with what to do next and **Back to sign in**. Rules: one wording for a wrong password and an
  unknown address, and "if an account uses this address" for codes and resets; refusals in our own
  words, never the API's; the password only in the screen's state (cleared after a refusal), sent in
  a POST body to the API's sign-in routes only, never in the address, storage, a log or an error;
  every Submit is disabled until the page's script runs, so a form cannot be sent natively; an
  emailed link's token is taken out of the address bar once read, offered only to the step it was
  read for, and the page sends no `Referer`; `autocomplete` set for password
  managers (`username`, `current-password`, `new-password`, `one-time-code`, `name`); every field
  labelled, its error read with it, and focus moved to the new step's title or the field to fix; a
  note on the first screen ("sign in again") is read with its title, which takes focus for it. One
  main button per view. Password, verify email, organisation and the code routes follow the API's
  spec; forgotten and reset password, invites and Google are on a hand-written assumed contract in
  `lib/api/sign-in-api.ts` and stay hidden (`LATER`) until the API serves them.
- **Companies (home).** **New company** above two cards per row (one below 960px): name, industry
  and the FDE's part (Lead, Engineer, or Organisation admin when they reach it as one), each project
  with its stage, and what needs the FDE there today. With no company it is the first minute of an
  engagement: a dashed card, **Add your first company**, that says what a company is and what comes
  after it (its people and systems, then a project), with **New company** as the one primary button.
- **Today.** An inbox: three cards in an 880px column, **Blocked** (blocked tasks, denied or revoked
  access), **Due** (open tasks due today or overdue, oldest first) and **Waiting on the customer**
  (tasks waiting on the customer, open access requests, longest wait first). Each item appears
  once: blocked wins over waiting, waiting over due. A row says what it is, where it is (company
  and project, and who has it when that is someone else: "Assigned to Jonah Ade") and why it is
  there, and **acts in place**. The agent runs card follows.
  - **One action per row, the rest in a menu.** The button is the move most likely wanted for
    why the row is there; the row's menu (the round dots button) holds the rest and **Open project**.
    Due: **Done**. Blocked task: **Unblock** (to In progress: the blocker is gone, so work resumes).
    Waiting task: **Received** (to In progress: the customer answered). A due task that is not yet
    started finds **Start** in its menu. The menu also has, for a task, **Mark done**, **Mark
    blocked…**, **Waiting on the customer…** and **Back to to do** (minus the status it is in).
    Those are the board's five moves, from the same code (`useTaskMover`, `MoveAsk`, `board.ts`).
  - **Access request rows** change status through `PUT .../access-requests/{id}`, which replaces the
    request (the project page's Access card uses the same mover, `useAccessMover`, and the same moves,
    `accessActions`), so everything but the status is sent as it was. The API puts no limit on which status
    follows which. Open (requested, in progress): **Mark granted**, with **Mark in progress**,
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
    in red, with Dismiss; a move held back because the task had changed says so with the amber dot and offers
    the move again on the current task (see **A stale save**); if the row has gone (deleted elsewhere), the reason is said above the
    groups instead. A dialog that fails stays open with its reason.
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
  - **What is left.** The line above the groups counts everything and says where: "19 need you
    across 5 companies: 5 blocked, 5 due, 9 waiting on the customer. 1 project has no next step."
    Groups with none are left out of the parts. "Nothing needs you today." appears only when the API
    has answered, every group is empty and every project has a next step; the three cards stay, each
    saying what is not there, so the page does not change shape as the last row goes.
  - **No next step.** The API's `projects_without_next_step` (the FDE's projects whose tasks are all
    done, or that have none: direction §4 says such an engagement needs a next step or is over) is a
    fourth card under the three, shown only when it has any. Each line is the project and its company,
    and one link, **Add a next step**, to the project with New task open (`?add=task`, cleared from the
    address once it has opened the form). These are not rows of the inbox: nothing here acts in place,
    so J, K and E skip them.
  - **Phones.** The button and menu sit beside the text, at 36px, and the key hints are not shown.
  - Signals from other tools (ADR 0006) will be more row kinds: a row is a `TodayItem`, its actions
    come from `actionsOf` (`src/lib/today.ts`), and `TodayRow` draws any of them.
- **Company.** Profile (summary, industry, region and the FDE's part, with **Edit company**), then
  Stakeholders (with their part) and Systems (with their kind) side by side (stacked below 960px),
  then Projects (with **New project**), then **Documents** (see **Documents and search**), then **Notes** (the company's own, see **Meeting notes**), then the Team. Each list has its add button in the card's
  heading, and a row opens its form. An empty card says what to add and why, so a new company reads
  as a list of next steps: "Add the people you work with at the customer: the sponsor who signs off,
  a champion, someone in IT."
  - **Main contact.** One stakeholder of a company at most, the one person to go to first. Their row
    says "Main contact" under their part, and a quiet line under the list names them ("Main contact:
    Mara Lindqvist, Head of operations.", or "No main contact yet") with **Change main contact** (or
    **Choose a main contact**), a small dialog with the company's stakeholders and "No main contact".
    It is its own route (`PUT .../main-contact`, `work`), not part of the stakeholder's form, because the
    API keeps it apart from the record; whoever was it stops being it, and the company is read again (both
    rows moved on a version). Nothing is sent when the choice is unchanged; a refusal (400
    `invalid_stakeholder`: not one of this company's) stays in the dialog and the list is read again.
- **Project.** The company link, with **Edit project** at its right, the **next step**, the summary, the stage bar, the **stage
  checklist** (see **The stage checklist** below), the **Board** (the one card that
  takes the canvas's full width, up to 1600px, once it has a task; empty, it stays in the 1040px page column
  with the others), Scope beside Success
  criteria, then **Proof** and **Eval suites** (see **Proof** below), then Access, Agent runs, **Notes** and Decisions, then **Assigned**. Scope and criteria are written
  in place (see **Scope and success criteria** below), Access and Decisions too (see **Access and
  decisions** below), and so are Notes (see **Meeting notes** below). Access and waiting tasks name people and systems from the company's records. A project with nothing written in it yet
  starts with a dashed note, **A new project. Start here.**, that says to name the people at the
  customer, agree the scope, and add tasks as the work takes shape.
  - **The next step comes first** (direction §4): the API's `next_step`, its first task in the board's
    order that is not done, worked out on every read. A quiet card, "Next step", with the task's title
    (the API's words, as text; a button that opens the task's own form, as its card does), who has it by
    name and when it is due (the amber dot when it is late; "Unassigned" and "No due date" said rather than
    left out). With none it says **No next step yet**, that every task is done or there are none, and offers
    one action, **Add a task**, in ink: what the page most needs then. A task saved, moved or
    deleted on the board or Today updates it at once by the same rule (`nextStepOf` in `lib/board.ts`),
    so a move needs no read of the whole project.
- **Writes: companies, projects and what they hold.** One form, `FormDialog` (`form-dialog.tsx`), is
  every create and edit in the workspace: the board's task form, the company, project, stakeholder
  and system forms. It checks what the API checks before it sends (`lib/records.ts`, in the API's
  own words), closes only when the API confirms, and keeps a refusal and what was typed in the
  dialog. An edit can end in a delete that asks first, in the dialog. Saving goes through
  `attempt`, and the confirmed record reaches the cached company, list and Today views
  (`commitCompanyCreated` and the rest of `lib/records.ts`), so the sidebar, Jump to and Home have a
  new company or project without a reload.
  - **Who is offered what.** Anyone in the organisation may create a company and becomes its lead.
    Editing the profile, starting a project, and changing the team or who is assigned need `manage`:
    the company's lead, or an organisation admin (`canManage`, from the FDE's part in their list and
    `GET /v1/me`). An engineer sees none of those buttons and a quiet line saying who changes them.
    Editing a project's name and summary, and stakeholders and systems, need `work`, which everyone
    who can open the page has. The API still decides: a refusal
    is shown as it is, in the dialog or the row ("You are not allowed to do that here"), never hidden.
  - **What is sent.** A company or project edit is a `PATCH` of the fields that changed, a blank
    field sent as `null` to clear it, nothing sent when nothing changed. A stakeholder or a system
    is a whole-record `PUT`: the form holds every field the record has (name, part, job title and
    email; name, kind and description), so what is not changed goes back as it was, with the version of the copy
    the form opened on (see **A stale save**). A new project
    starts at Discover; the caller leads a new company.
  - **Removing** a stakeholder or a system asks first, in the dialog. A stakeholder who has signed
    off a scope cannot be removed (the API answers 409) and the dialog says so. Access requests and
    tasks that named a removed person or system are left naming no one.
  - **Team and Assigned.** Each row is a person by name (see **People** below). A lead or an admin
    **adds someone** to the company from the organisation's people (`GET /v1/people`, minus the team),
    with a role (Engineer unless changed), and changes a member's role or removes them (the role is a select that shows the saved role until the API
    answers; removal asks in the row), and assigns or unassigns engineers on a project from the
    company's team. A refusal stays in the row. The only lead is never offered for removal or a
    change of role (the API would allow it): their row says "A company always has a lead. Make
    someone else lead first." A lead who makes themselves an engineer is asked first, in the row. When
    the organisation's people cannot be read (503, or 403), the card says so and offers no one to add,
    never an empty list as if nobody existed; **Try again** reads them again after a 503.
- **People.** Every screen names a person the same way, through `useNames` (`components/people.tsx`)
  and `personOf` (`lib/people.ts`): a task's assignee on the board and on Today, the Team and Assigned
  cards, who recorded a sign-off, who uploaded a document, who started an eval run, and who attended a
  note. A decision's "who decided" is a name the FDE typed, not a user, so it is shown as written.
  - **Where names come from.** `GET /v1/people` (the organisation's own admins and members, by name, no
    emails), read once and kept five minutes as the API keeps it, never retried on a 403 or 503, and not
    read again on focus; and the names on a company's members and a project's assignees, taken from the
    cache without reading them again. Only `/v1/people` can say someone has no name: a member without one
    may only mean WorkOS did not answer.
  - **What a person reads as.** **You** for the signed-in person, always. Otherwise their name; **Unnamed
    teammate** when WorkOS has neither a first nor a last name; **A teammate no longer listed** when the
    list answered without them (they have left). When the list cannot be read, the screens fall back to
    what they showed before names, **A teammate …abc123** (the end of the id), and the cards and forms
    that offer people say plainly that names are unavailable. Nobody is ever an id alone. A nameless
    person is drawn quieter, with the outline of a person for initials.
  - **Names are untrusted text with no length cap.** They are rendered as text, never markup. In a row, a
    pill or a card a long name is shown whole and wraps where it does not fit (`[overflow-wrap:anywhere]`):
    a name cut with its rest on hover only would hide it from keyboard and touch. A select's option holds
    the whole name too, so a screen reader hears all of it; the browser fits it to the list. Our own words
    for someone without a name ("a teammate …abc123") stay on one line. A person's id is checked with the
    platform's rule before it goes into an address. A name is never logged, put in the address or kept in
    browser storage.
  - **Picking teammates.** Who has a task (the task form) and who from the team attended a meeting (the
    note form) are chosen from whoever works on the place as the page can read it: you, the company's
    team and, on a project, its assignees, you first and the rest by name. The API also lets an
    organisation admin who is not on the team work there; the page cannot list them, so they are not
    offered. Someone already chosen stays a choice, even when they no longer work there.
- **A stale save.** The API versions six records (a task, an access request, a stakeholder, a system, a scope
  item, a criterion; and the scope as a whole, for a sign-off), and a save that names a version the record has
  left is refused with a 409 `stale_version` and the record as it stands (`current`). Nothing was changed. The
  shared saving code owns all of it, so every screen behaves the same (`api.update*` in `client.ts`,
  `useTaskMover`, `useAccessMover`, `useVersionedForm`); a screen does not handle it by itself.
  - **The rule: a save is based on one copy, and sends that copy's version.** For a one-click move it is the
    record as the page has it at the click (a Today row, a board card, an Access row); for a prompt (into Blocked
    or Waiting) the record as it was when the prompt opened; for a form the copy taken when the form opened. Every
    field comes from that copy plus what the person changed, the version of that copy goes with it, and nothing is
    taken from a newer copy the page has read meanwhile. So a form opened on an old copy is refused when the record
    has moved on, instead of quietly putting a teammate's change back or leaving it out. A create sends no
    version (the API answers 400 `invalid_version`); the update calls take it as an argument and the create
    calls cannot (`TaskBody` and its kin leave `version` out). A response schema refuses a record without a
    version: the API always sends one, and a record without it could only be saved unchecked, so the page fails
    loudly instead of going back to the last writer wins (the spec still marks it optional until the API makes
    it required).
  - **Never retried, never forced.** The page puts `current` into its caches first (reads sent before are
    cancelled, as for every write), so what it shows is true, and tells the person plainly. Only the person's next
    action sends anything, and it names the version of `current`, so it can be refused again, and is told again.
    The three 409s of a task save and a sign-off are told apart by `error === "stale_version"`; the others keep
    their words (`rejected_blocker_required`, `rejected_empty_scope`, `conflict`).
  - **A one-click move** (a card's Move to, a Today row, an Access row): the page shows the record as it now is,
    and says so where the move was made, in a note with the amber dot (it is not an error, so it is not red): "This
    task changed since you last read it, so it was not moved. It is now In progress." (the title is named when the
    note is above the board or Today's groups, because the row is not there to show it), with **Move to Done** to do
    the same move on the current record, and **Dismiss**. If someone already made the move, there is nothing to offer,
    and the note only says so: "Someone already moved “Replay last month's orders” to Done." Access says "Mark
    granted" or "Ask again", the move's own words. A move into Blocked or Waiting is made from its prompt, which is
    a form (below).
  - **A form** (the task, stakeholder, system, scope item, criterion and access request forms, and the prompt into
    Blocked or Waiting) stays open with every word in it. A notice above the buttons, with the amber dot, says "This
    task changed after you opened it, so nothing was saved." and names the fields that differ between what the
    person started from and `current` ("Someone changed the status and due date. What you typed is still here."),
    and, where the person also changed one of those, "You also changed the status, so yours replaces theirs."
    The page behind it already shows `current`. The form now holds what the person typed on top of `current`: the
    fields they changed keep their value, every other field takes the current one, so what the next save would send
    is what the form shows (`staleness` in `lib/stale.ts`). The button says **Save on the current version** and sends
    that, with `current`'s version; Cancel leaves the record as it is now. It names fields, not values: a value is an
    id for several of them (a person, a system), and the form does not show a status that the Access form does not
    hold, so the notice names it and nothing more.
  - **A sign-off** is on the scope's version as the person read it (`ScopeOut.version`), sent as `version`. If the
    scope has moved on, nothing is signed, and the dialog stays open and says so: "The scope changed while this was
    open, so nothing was signed." It lists what changed (Added, Changed, Removed, each with its words), shows the scope
    as it is now (in scope, out of scope, criteria), takes that as what is being signed (the sentence at the top counts
    it), and asks for a tick, "I have read the scope as it is now, and Kestrel agreed to this version.", before
    **Record sign-off** will send anything. The re-read before the sign-off stays as a courtesy: a scope that moved
    while the dialog was open is told the same way without a sign-off being attempted. The version is the protection:
    the API checks it under the scope's lock, which a re-read cannot.
  - **A delete** names no version (the API takes none yet), so it is never held back: it removes the record
    whatever was changed since. A form still open on that record keeps what was typed, and its Save says
    "The task is no longer there." in the form's alert; a one-click move on it says the same, and the page reads
    it again.
  - **An identical save** is answered by the API as it is, with the record's version unchanged, so the form closes and
    nothing moved. The access, scope item and criterion forms still send nothing when nothing changed (as before), which
    saves the round trip; the stakeholder, system and task forms send it and the API says nothing changed.
- **Scope and success criteria.** Where an FDE and the customer agree what "done" means, and what the
  customer will later read. Everything here needs only `work` on the project, which anyone who can
  open the page has: the API guards every scope route, read and write, with it alone, so an engineer
  sees every control. A refusal is still shown, in the dialog.
  - **Scope** lists _In scope_ and _Out of scope_ as two lists, each with its own **Add**; a row
    opens its form. Each item is saved on its own (the API takes one at a time), so each opens in a
    dialog: a long item gets a tall field to write in, and the card shows it in full, lines kept.
    The form has the side (**Listed as**, so an item can move across) and the words. An item is
    changed with a whole-record `PUT` and removed after asking, in the dialog.
  - **Success criteria** reads as an agreement: the sentence the customer would agree to, then
    "Met when plans accepted unchanged is at least 70%." The form is that sentence in parts (what
    must be true, what is measured, at least or at most, the target, the unit) and shows how it will
    read once there is enough to read. A target is typed as text and read as a number; zero is a
    target. Under it, **Baseline** (typed as text and read as a number, in the target's unit, which its
    hint names; blank is none, zero is one) and **How we will prove it** (a few words: an eval suite, a
    result the customer shares; plain text, 1 to 500 characters once trimmed, newline and tab allowed,
    shown as text). The card shows "Baseline 45 min." beside the target, or "No baseline measured yet."
    (direction §4: a missing baseline is why value cannot be shown later), and the proof under it.
  - **Every save sends the baseline and the proof.** The API's `PUT` clears either when it is left out, so
    `criterionBody` returns `CriterionSave`, whose `unit`, `baseline` and `proof` are required (null to
    clear). Both are part of what is signed: changing either bumps the scope's version like any other
    change, and the form of a signed-off scope says so before it saves ("...the baseline and how it will
    be proven are part of what was signed. Saving this change means it needs signing off again.").
  - **Empty states** say what a good scope has, in a line each: the outcome, what is out, and how
    done is measured. A scope with nothing in it offers no sign-off.
  - **Sign-off has three states**, said in the card's heading and again in a panel below the lists:
    **Not signed off** (grey dot; the panel offers **Record sign-off**), **Signed off by Mara
    Lindqvist, 3 Nov 2026** (green dot; the panel says who recorded it and that a change will need a
    new sign-off) and **Changed since sign-off** (amber dot; the panel says who signed the earlier
    version, how many changes have been saved since, and offers **Sign off again**). The count is
    the scope's version minus the version signed.
  - **What the API does with an edit.** Every add, change or removal of an item or criterion
    bumps the scope's version, and the last sign-off stays on record but no longer covers it
    (`signed_off` turns false). Nothing is cleared and nothing is refused. So the form of a signed-off
    scope says so before it saves, "This scope is signed off. Saving a change means it needs signing
    off again.", and the removal question adds it. A save that changes nothing is not sent (the API
    answers an identical save as it is and counts no change, so it would be a round trip for nothing). Each
    save carries the item's or criterion's own version, not the scope's. A removal is never refused, even for a
    criterion that has results.
  - **Recording a sign-off** asks who at the customer signed (any stakeholder of the company; sponsors
    are listed first; the person who signed before, or else the company's only sponsor, is chosen in
    advance, and nothing is recorded until **Record sign-off** is pressed). It says what is being signed, in numbers, and what is missing without refusing it:
    nothing listed as out of scope, no success criteria. The sign-off names the scope's version as it was read, and a scope that moved on is refused
    (see **A stale save**); the dialog also reads the scope again first, as a courtesy, and says the same if it moved while the
    dialog was open. One version is signed once: a second sign-off of it is a
    409; the dialog says so, and the scope is read again so the card behind it shows who signed instead of staying on "Not signed off". The API refuses an empty scope (409), and a person who is not a
    stakeholder at the company (400).
  - **Focus.** When a dialog closes, focus goes back to the row that opened it, or to the section's
    **Add** when that row is gone, or, after a sign-off, to the sentence that now says it is signed.
- **The stage checklist.** The page's answer to "what does this stage need, and what do I do next?":
  a card, **To leave Scope**, directly under the stage bar and above the board, in the page column. The
  API names the items (`GET .../stage-checklist`: a stable key, a label and whether it is met; the
  checks and their words are `oryxa_fde_core::checklist`). The page adds, for each open one, what is
  missing in a plain sentence and a button to where it is put right (`lib/checklist.ts`, `hintFor`).
  An open item is information, not an error: no red, and no amber either (amber is for a move that is
  held up, below). An open item is a hollow ring, a met one a green check with its label in the muted
  tone; a screen reader hears "Open:" or "Met:" first.
  - **Where each item goes.** Stakeholders named: a link to the company page with **Add stakeholder**
    open (`?add=stakeholder`, cleared from the address once it has opened the dialog). Scope signed off:
    **Record sign-off** or **Sign off again** (the sign-off dialog), but **Add stakeholder** first when no
    one at the customer is named, and **Add to scope** first when the scope is empty. Out of scope
    listed: **Add out of scope** (the scope dialog, on that side). Criteria set: **Add criterion**
    (the criterion dialog). Access granted: **Go to Access**, which scrolls to the Access card and
    focuses it, or **Request access** (the Access card's form) when no request exists. The API counts
    no request as met ("a project may need no access"), so that button only shows to a view that has
    not caught up. An eval suite on every criterion, and every
    criterion met: **Go to proof** (the Proof card, focused), or **Add criterion** when
    there are none. Both items are read again after anything on the Proof cards that the API confirms
    (a suite created, a run finished), as a scope change reads them. A meeting note on the project: **Write a note**, which opens the Notes card's
    blank note. The line says that a note written on the company does not count: the API meets this item
    only with a note on the project. A key the page does not know shows the API's label and nothing to press.
  - **When all are met** the card collapses to one quiet line with a green check, "Ready to leave
    Build. Everything it needs is in place." A stage with no items (Deploy, Handoff, Operate today)
    shows nothing. While it is being read, a quiet "Reading what this stage needs…"; if the read
    fails, one line with **Try again**; the rest of the page is unaffected, and a move still works (the
    API judges it).
  - **It stays true.** It is read under the project's own key, so a scope item or criterion added,
    changed or removed, a sign-off (also one the API says was already recorded), a stage move and a
    change to the company's people all read it again, with in-flight reads cancelled first, as every
    other write on this page does. It is shown only for the stage it names, so the old stage's list is
    never shown under the new stage. A task is not a checklist input, so a task move does not read it.
- **Access and decisions.** Where engagements stall, and what was agreed. Both cards sit under the
  scope cards, in the page column, and need only `work` on the project like the scope does.
  - **Access answers three things first.** A quiet well above the rows says **Not granted** ("2 of 3"),
    **Held up by** (the owners of what is not granted, most requests first, "Tomas Becker (2), Ines
    Moreau"; "No one named" for a request nobody owns) and **Longest wait** (the oldest open request,
    in days, with the amber dot from a week, `LONG_WAIT_DAYS`). With everything granted it is one line
    with a green check instead. Amber is for denied, revoked and a long wait only.
  - **Rows** are in the order the FDE chases: denied or revoked first, then open (requested, in
    progress), then granted, the oldest request first in each. A row has what is asked, **Owner:** the
    stakeholder (or "No one at the customer is named to grant it"), the system and the day it was
    requested, one line for its state (**In progress, waiting 11 days**, or **waiting less than a day** for a request asked today;
    **Denied 5 Nov 2026, after 4 days**; **Granted 3 Nov 2026, after 3 days**; **Revoked 9 Nov 2026. It
    had been granted 3 Nov 2026, after 3 days.** for a grant that was taken back) and, when tasks name it as their blocker, **Blocks 2
    tasks:** with their titles. The days come from the API's `days_waiting` (from the request until it
    was settled, or until now while it is open), so a settled request's number stops. For a revoked
    request the API counts to the grant, not to the revocation, so the line says that the days were the
    grant's and when it was granted, rather than "revoked after 3 days" for something revoked weeks on.
    A day count of zero is "less than a day" everywhere (Today, the board and the card), because the
    API counts whole days and "since today" read oddly beside yesterday's date.
  - **Moves.** The first button is the move most likely wanted, as on Today (**Mark granted** for an
    open request, **Ask again** for a denied or revoked one); the round dots menu holds the rest and
    **Edit request**. A granted request has no button, only the menu (**Mark revoked**, **Ask again**),
    so it is not undone by accident. The API puts no limit on which status follows which. A moving row
    stays where it is, dimmed, its state line saying "Moving to Granted…", and moves to where its new
    status sorts only when the API answers; a refusal is said in the row, in red, with Dismiss. When
    the move was a grant, the checklist is read again at once and the project once more a few seconds
    later, because the API puts the tasks blocked on it back to do by an event.
  - **Request access** (header button, or the checklist's) asks **What access is needed**, **Which
    system** (the company's, or none) and **Who at the customer owns it** (a stakeholder, or no one
    yet), and starts the request as requested: the API takes a new request as requested or in
    progress only (409 otherwise). **Edit request** changes those three fields. Its status is not in
    the form: it is changed from the row.
  - **Edits are whole-record `PUT`s** (the API replaces the request): all four fields are sent, from the
    copy taken when the form opened with the person's changes, and the status is that copy's. The copy's version goes
    with them, so a status moved while the form was open is refused, not undone: the form says the status changed and
    offers to save on the current version (see **A stale save**). A save that changes nothing sends nothing. There is no
    way to remove a request: the API has no delete.
  - **Tasks blocked by a request.** `blocked_by` takes one of this project's access requests (any
    status), only while the task is blocked; when the request is granted the API puts the tasks
    blocked on it back to do, by an event. The blocked prompt, on the board and on Today, and the task
    form of a blocked task offer **Blocked by an access request** under the blocker: the project's
    requests that are not granted (requested, in progress, denied, revoked), or "None, something
    else"; a task that already names a granted one keeps it. With no request, no field. Today reads
    the project's requests when its prompt opens.
  - **Decisions** are a log: newest first by the day they were made, each with what was decided, why,
    who decided (a name, often someone at the customer) and when. **Log a decision** asks all four
    (the day defaults to today and cannot be a day to come; today is left to the API's own timestamp,
    an earlier day is sent as noon where the FDE is). The API's log is append-only, so a decision
    cannot be edited or removed, and the form says so before it saves. A decision that was promoted
    from a discussion says **Promoted from a discussion about the access request "Telematics
    export"**: the API names the decision on the thread, not the thread on the decision, so the page
    reads the project's threads and matches them; the subject is named from the records the page has,
    never by id, and nothing is said when the threads cannot be read.
  - **Field problems.** `FormDialog` marks the field a problem is about (`aria-invalid`, described by
    the alert) and moves focus to it; a refusal from the API that names a field (`invalid_owner`,
    `invalid_rationale`, …) does the same, and nothing typed is lost. A problem about no field stays
    the dialog's alert.
  - **Focus.** When a dialog closes, focus goes back to the row that opened it, or to **Request
    access** or **Log a decision**. After a move is confirmed it stays on the row, wherever that now sorts.
- **Meeting notes.** Where a call becomes a record, and from it commitments. The **Notes** card is on the
  project page (after Agent runs) and on the company page (after Projects): the same card, with the same
  form. Anyone who can open the page may read, write, change and remove a note: the API guards all
  five routes with `work` alone.
  - **The list** is newest meeting first, as the API sends it: the title, the day it was held ("3 Nov
    2026"), who was there ("Attended: You, Jonah Ade and Sam Okafor", past three "You, Jonah Ade and 2 others";
    "With Mara Lindqvist, Ines Moreau") and, under
    it, the first two lines of the note. The title is a button that opens the whole note in place
    (`aria-expanded`); **Edit** is at the right. A note is **plain text**: the body is customer content, so it is
    rendered as text with its lines kept (`whitespace-pre-wrap`), never as HTML or Markdown, and a note
    that holds `<b>` or `**` shows those characters. Reads fail on their own: the card says "We couldn't read
    the notes." with **Try again**, and the rest of the page is untouched.
  - **A dialog, not a page.** The note form is a dialog (720px, the one wide form) because the FDE writes it from the
    project they are looking at and must come back to the same place: no route to leave and return
    to, no draft to keep somewhere else. It is the shared `FormDialog`, so it has the saving rules
    of every other form. The words get the room: a field about 42% of the screen high that can be
    pulled taller, a counter ("1,204 of 20,000 characters", red over the limit), and the title and the day
    side by side above it, small. The cursor starts in the words. Who was there sits below: **who from
    your team** (everyone who works on the company or project, by name, you ticked for a new note, and
    anyone the note already names) and **who from the customer** (the company's stakeholders), each a
    pill with a checkbox.
  - **What the API holds.** `title` (a name: one line, 1 to 200), `held_on` (a day), `body` (1 to
    20,000 characters once trimmed, newline and tab allowed, no other control character), `stakeholders` (the
    company's, up to 50) and `attendees` (users of the workspace who work on the company or project, up to
    50). A `PUT` replaces the whole note, so an edit sends every field: what the form changed, compared with
    the copy taken when it opened, is the form's, and every other field is the note as the page has it
    now, so a teammate's change to another field is not undone. A save that changes nothing sends nothing.
    A refusal names a field (`invalid_title`, `invalid_held_on`, `invalid_body`, `invalid_stakeholders`,
    `invalid_attendees`): that field is marked, takes focus and says so.
  - **People.** Attendees are user ids, named as everywhere (see **People** above). Someone on a note
    who no longer works there can be unticked and ticked again, and is kept on a save.
  - **Words are never lost.** Nothing shows as saved until the API confirms. A refusal or a network failure keeps
    the dialog open with every word in it and says what happened. Cancel, Escape and a click outside ask
    first when there is something to lose ("Leave without saving this note? What you wrote is lost."): the
    safe answer, **Keep writing**, has focus, so pressing Escape twice does not throw a long note away. A
    note nobody has written in closes at once. Leaving the page with words in the note (the back button, a
    link, Jump to, or the redirect to sign-in when the session has ended) asks the same question first, and
    closing or reloading the tab gets the browser's own. Removing asks first, in the dialog. The counter is
    said to a screen reader once typing pauses, not on every key.
  - **From a line to a task or a decision.** While writing, **Make a task** and **Log a decision** sit under the
    words; while reading an open note they sit under it. Each opens the board's task form or the
    Decisions card's decision form (the same forms, saving and refusals), with the title started from
    a line. **Which line:** what is selected in the note, or else (while writing) the line the cursor is on,
    or else nothing, for the FDE to type. Why not a button on every line, or a parser for "- [ ]": a
    selection and a caret work with a mouse, a finger and a keyboard (shift and arrows in the field),
    need no widget on a long note, and the fallback is simply typing a title in a form that is open
    anyway. The title is one line: lines are joined, a list marker or checkbox is dropped, and it is cut at the
    API's 200 characters. A selection in a note being read is remembered when it is made, because a tap
    on a button can empty it first; it is used once. The task or decision form opens
    **over** the note, inside its dialog (so Escape closes the form only), and the note stays as it was,
    with everything typed in it. When it saves, the dialog says "Added the task “...” to the board." or
    "Logged the decision “...”." where the FDE is, and focus goes back to the button they pressed. The
    task is on the board behind it at once.
  - **No link from a note to what came of it.** The API has no field that ties a task to a note, and the page does not
    fake one. A decision could be tied through a discussion about the note (`subject_kind` allows
    `meeting_note`, and a project's thread is promoted once to a decision), but that is two calls with
    no transaction between them, an opening comment the FDE did not write, and a thread left behind if the
    second fails; so it is an API gap (a decision logged with its source note), noted on the issue.
    A company note has neither button: a task and a decision belong to a project, and a company has several.
  - **What counts for the checklist.** The Discover item "A meeting note on the project" is met by a note
    **on the project**. A note on the company does not count (`discovery_notes` in the store checks the
    project's rows only). The company's Notes card says so under its heading; the checklist's line says so
    when the item is open; the project's Notes card lists only the project's. The checklist is read
    again after a note is added to a project or removed from it (not after a change to one, which cannot
    change the count). Removing a project's only note, while it is at Discover, says in the question that
    the checklist will ask for a note again.
  - **Focus.** When a dialog closes, focus goes back to what opened it: the row's **Edit**, the card's **Write a
    note**, or the checklist's button; if that has gone (a removed note, a checklist item now met), to **Write a
    note**.
- **Documents and search.** The customer's files, and finding what is in them. The **Documents** card is on the
  company page, between Projects and Notes. Everything here needs `work` on the company, which anyone who can open
  the page has, so an engineer sees every control; the API still decides, and a refusal is shown. The API has no
  project scope for documents (a document belongs to the company, and the project search route searches the same
  company), so there is no per-project list; the card is the company's alone.
  - **The list** is newest first, as the API sends it: the name, the kind and size ("PDF · 1.2 MB"), how many
    passages it was read into once it is ready, who added it and when ("Added 3 Nov 2026 by you", "by Jonah Ade"; see **People**), and its status
    at the right, a dot and words.
  - **Status says only what the API says.** `pending` is **Being read** (neutral dot, with "It can be searched once
    it has been read."), `ingested` is **Ready** (green), `failed` is **Could not be read** (amber, as a failing
    thing is), followed by the reason in words from the API's code (`unreadable`, `empty`, `too_large`, `too_slow`,
    `checksum`; a code the page does not know says "It could not be read." and the code is never shown). The API cannot tell a document that
    is waiting in the queue from one a worker has open, so "Being read" is the one word for both. Nothing is
    called Ready until the API says `ingested`, and an upload is not in the list until the API has stored it.
  - **No delete, no re-read, no download.** The API has none of them, so none is offered. A failed document stays; the
    card says so under the list ("A document cannot be removed or read again from here yet. Upload a corrected copy as
    a new document."). There is no link to a file's bytes either (the API returns none), so a name is text and a
    passage is text; nothing opens a document.
  - **Polling is gentle.** While any document is being read, the list is read again after 2 seconds, then every 5
    (after 20 seconds), 15 (after a minute) and 30 (after five minutes), and it stops at fifteen minutes with "Some
    documents are taking longer than usual to be read. **Check again**", because something is then slow or stuck and
    asking for ever helps no one. It stops as soon as nothing is being read, when the page is left, and while the tab is
    hidden (it reads once when the tab is shown again). When a document finishes the card says so ("“x” is ready to
    search." or "“x” could not be read.").
  - **Upload** is a dialog, `FormDialog` and the shared saving rules: **Upload a document** opens **File**, **Name**
    and one quiet line, "Sample data only for now. Files are kept under the shared environment key until each company
    has its own." (written unconditionally: the API does not yet say whether a company has its own key, #166).
    One file at a time, because the API takes one. The chooser takes text, Markdown, PDF and Word (`.docx`), up to 20 MB;
    a file dropped on it is chosen as well (the browser does that for a file input). The type is the browser's, or the
    file name's extension when the browser has none (`.md`); nothing inside the file is read. The name starts from the
    file's and is the person's once they have typed in it (one line, 1 to 200 characters). The page checks what the API
    checks before it sends, in words about the file: nothing chosen, empty ("That file is empty."), over 20 MB, a kind
    the API does not read, a bad name; each is tied to its field and moves focus to it.
  - **How an upload travels.** The browser sends one `POST /api/v1/companies/{company}/documents?name=...` to this
    app's own origin: the file as the raw body (not multipart, not a presigned URL), its type as the `Content-Type`, the
    name as a query value encoded as one value, and the `X-Oryxa-Request: 1` header every write carries. It goes
    through `XMLHttpRequest` (`Transport.upload` in `client.ts`), because a browser reports an upload's progress that way
    only, with the same cookies and origin as `fetch`. The Worker checks the `Origin`, refuses a body over 20 MiB with
    `413 payload_too_large` (by its declared length, and by counting a body that declares none), and forwards the rest
    to the API with its type and bytes untouched. The API refuses a type it does not read (415), an empty body (400
    `invalid_body`) and a name that breaks the rule (400 `invalid_name`), checks `work`, puts the file in S3 under the
    company's prefix and records a `pending` document whose `document.uploaded` event wakes the worker that reads it.
    The browser never talks to S3. The limit end to end is **20 MiB** (20,971,520 bytes), which is the API's, and
    Cloudflare's own limit for a request body (100 MB on the smallest plans) is above it.
  - **Progress is honest.** A bar for the bytes that have left the browser ("Sending 1.2 MB of 3.4 MB"), and when all
    have gone, "Sent. Waiting for the workspace to store it…" with the bar full, because the Worker and the API then
    still take the body, check it and store it. A screen reader hears the phase, not every percent. Save reads
    "Saving…" and is off until the API answers.
  - **A file that did not go stays chosen.** A refusal (too large, wrong kind, empty, a bad name, not allowed, the
    API unavailable) or a connection that failed keeps the dialog open with the file chosen and the name typed, says
    why in words, and marks the field it is about; Upload sends it again. The API's refusals of a file are said about
    the file ("That file is over the 20 MB limit.", not the note's words for `invalid_body`). Cancel, Escape or leaving
    the page stops an upload in flight and reads the list again, because the API may already have the document.
  - **Search** is a field at the top of the card. It sends after a quarter second without typing (and on Enter, even for
    one character; on its own it waits for two, because each search costs the API a model call), keeps the last answer on
    the screen, a little dimmer, until the next arrives, and drops a read that is no longer wanted, so it feels instant.
    Escape clears it. The words go to the API as one query value, 1 to 500 characters, with its operators (words,
    "quoted phrases" and -exclusions). While there are words, the results take the list's place; clearing them brings the
    list back.
  - **A result** is the passage in context: the document's name, its kind, and where in it ("Passage 4 of 12": the
    API's `chunk` from 0, and the document's `chunks` from the list), then the text. The API returns only the passage and
    an order (its `score` means nothing but order, and is not shown), so there is no page, no character position and no
    link into the file. The words typed (not the exclusions, and not `or`) are marked, as text, in bold on a quiet
    ground, wherever they occur in the passage, also inside a longer word. That is all the page knows: the API also
    finds by meaning and by word stem, so a good passage may hold none of them, and is then shown without marks. A passage
    longer than about 320 characters shows a window around the first mark, cut at spaces, with ellipses and **Show the
    whole passage**. The line above says how many were found and for what ("3 passages for “driver hours”, best first.").
  - **Empty and partial.** "No passages match “zebra”." with a hint to try other words; "No document has been read yet,
    so there is nothing to search." when none is ready; and always, under the count, what a search cannot see: "1
    document is still being read and cannot be searched yet. 1 document could not be read and cannot be searched." A
    search is read again, with the same words, when a document finishes being read.
  - **Customer content is text.** A file name, a passage and a query are rendered as text nodes and in `aria-label`s only:
    never as HTML or Markdown, never in a URL path, never in an attribute that runs (a name in the upload URL is one
    encoded query value). A name or passage that holds `<img onerror>` or `**bold**` shows those characters. The marks
    are made by cutting the text into pieces and wrapping some in `<mark>` elements; the pieces are never parsed.
    The page reads nothing of a file: the browser streams it, as chosen. The page puts no text from a document in the
    address bar or in storage.
  - **Not here yet.** Documents in Jump to: Jump to switches between companies and projects, and searching inside one
    needs the company chosen first, which is not a small step; the card's search is the way. Documents on the project
    page: the API does not scope them to a project. A document's key, its download or view link, a delete and a re-read
    are not in the API.
- **Proof.** The part of the product the FDE's loop is built around: "is this criterion met, and how do we
  know?". Two cards on the project page, after Scope and Success criteria: **Proof**, one row per criterion, and **Eval
  suites**, the depth behind it. Everything here needs `work` on the project, which anyone who can open the page has
  (the API guards every eval route with it, except `eval-criteria`, which the page does not use). Where the API serves no
  evals, the cards say so (see **Where the API serves no evals**).
  - **A row is one glance.** What the criterion says (the customer's sentence), a status (a dot and words), the number
    against the target, from its baseline when it has one ("**0.75** against at least 0.7, from a baseline of 0.42";
    with no result, "Target: at least 0.7 · Baseline: 0.42"), how fresh it is ("Measured 5 Nov 2026, 5 days ago"), how many
    cases passed, which suite it came from and whether the outputs were imported or run in the sandbox, and a trend: a
    row of up to eight small bars, one per recent finished result (height is the result's own rate, 0 to 1), the latest
    darker, neutral in colour, with every value in text for a screen reader and as the bars' title ("Recent results,
    oldest first: 0.58 (7 of 12), 0.67 (8 of 12), 0.75 (9 of 12)."). The bars need two results to show. The suite's name
    under the row opens it in the Eval suites card. Last, one quiet line names the tasks that work towards it, in the board's order, each
    with its status ("Tasks towards it: “Replay last month's orders” (to do), “Run the first replay” (done)."), the
    first three and "and N more"; a criterion no task works towards has no such line. How it will be proven, when the
    criterion says, is one quiet line ("How we will prove it: ..."), as text.
  - **The statuses.** **Met** (green) and **Not met** (amber, because it is failing) are the API's verdict and nothing
    else; **No result yet** (a suite measures it and no finished run has produced a value), **No eval suite** (nothing
    measures it) and **Not read yet** (the verdict could not be read) are neutral. A run that is going says "A run
    started 5 Nov 2026 is being graded." and keeps the last finished value above it. Each status of no result says what
    to do next, with the button to do it: **New eval suite for this**, **Run in the sandbox** (when the criterion has one
    suite with a target and cases), **Open the suite**.
  - **"Met" is the API's, never the page's.** The page works out no verdict and no pass rate. `GET /v1/room/...` returns
    each criterion with the API's latest value, `passing` (the value against the target on the criterion's side of it:
    `at_least` is `>=`, `at_most` is `<=`) and when it was measured. That is the same rule that drives the stage
    checklist's "Every criterion meets its target" (`ProjectTx::criteria_met`) and the "ready to deploy" suggestion.
    The room is the customer's view, and an FDE with `work` reads it too. The heading's "1 of 3 met" is its
    `criteria_passing`. What the page does find itself is where a value came from: the API records a value in the same
    transaction that ends the run, so the source is the run of a suite that measures the criterion whose `ended_at` is the
    value's `measured_at` and whose rate is the value. Two runs with the same rate are told apart by that time; if no run
    matches (the runs list is older than the verdict), the row claims no source, no suite and no case count. Inferred until
    the API returns the run (#193). The trend is the same runs' own `passed`, `total` and `rate`.
  - **What a value is.** The API sets a criterion's value to `passed / total` for the cases that measure it, so it is a
    pass rate from 0 to 1, and compares it with the target **as written**. A target written as a percentage ("at least
    70%") can never be met, and one in another unit ("at most 2 min") is met by any rate. The row says which ("An eval
    result is the share of cases that passed, from 0 to 1, and for now it is compared with 70 as written, so no eval result
    can meet this target." or "..., so every eval result meets this target, whatever it is.") rather than leave a verdict
    that means nothing unexplained. It does not ask for the target to be rewritten: a criterion is written in the
    customer's terms, and the API is to compare in the criterion's own unit (#193), when this note goes.
  - **Fresh, and out of date.** The API's `measured_at`, in words and a date. A result is **out of date** (amber, with the
    reason) when the criterion was changed after it was measured, or when it is 14 days old (`STALE_DAYS`); the verdict
    above it is still the API's.
  - **Errors count as not passed.** A case the target or a grader could not decide is **Could not be graded**, and the API
    counts it as not passed, so a run that could not grade never shows a better rate than it earned.
  - **Eval suites** lists the project's suites, newest first: the name, how many cases, where outputs come from
    (a command run in the company's sandbox, or results imported), the criteria it measures and its last run. A suite opens
    in place (`aria-expanded`): where outputs come from, its graders (all must pass; five kinds: exact match, regular
    expression, JSON schema, a script in the sandbox, a model judge) with the pattern, schema, command or rubric as text,
    its buttons (**Run in the sandbox**, **Import results**, **Add cases**), its runs, newest first, and the one chosen in
    full: running or finished, who started it and when, imported or run, the counts the API reports ("18 passed, 1 failed, 1
    could not be graded"), each criterion's "18 of 20 cases passed (0.9)", and the cases. The cases that did not pass come
    first, each folded to its id and outcome; opening one shows the input, the expected output, the output, and each
    grader's verdict in the suite's order with its reason. The cases that passed are behind one button. Lists of cases show 20 at a
    time. **New eval suite** is also here.
  - **A run starts only where the API allows it.** **Run in the sandbox** is for a suite with a target command and at
    least one case (the API answers 409 `rejected_no_target` and `rejected_no_cases` otherwise, and the page says why it is
    off before the API is asked). It runs in the company's sandbox, on sample data only for now (ADR 0004), waiting its turn
    behind an agent run if one holds it. One quiet line under the Proof heading says so. A suite without a target grades
    **imported results** instead.
  - **A run is finished only when the API says so.** The API answers a start with `202` and a run that is `running`; its
    report arrives when the grading ends. The page shows the run as **Running** and polls that run (not the list) after
    2 seconds, then every 5 (after 20 seconds), 15 (after a minute) and 30 (after five minutes), as the documents card does
    (`pollDelay`). It stops when the run finishes, at fifteen minutes with "A run is taking longer than usual to finish.
    **Check again**" (a run's own limit is an hour, and a run left `running` after its API task stopped is an API gap, #76),
    when the page is left and while the tab is hidden. When a run ends the card says so ("“Time to a first draft” has
    finished: 8 of 10 cases passed."), and the room, the checklist and the runs are read again.
  - **New eval suite** (`FormDialog`) asks the name, the criteria it measures (at least one, the ones the Proof row opened it
    for ticked), the graders (up to eight, each with its own fields: ignore case; a pattern; a JSON schema; a command, one
    argument per line, and a time limit; a rubric) and where outputs come from (**Results I bring**, or a command run in the
    sandbox). Cases come next, from a CSV. The API answers a refused suite with one code, `invalid_suite`, so the page checks
    each part before it sends and says which, tied to its field.
  - **Importing a CSV.** **Add cases** takes columns `input` (required) and optionally `expected`, `id` and `criteria` (ids
    separated by `;`); **Import results** takes `case` and `output`, for the cases of that suite. The file is sent as it is,
    as the raw body with `Content-Type: text/csv` through the same upload path as a document (`Transport.upload`, with the bytes
    sent shown), up to 8 MB. **The API takes a whole file or none of it, and says only that it refused it** (`invalid_csv`,
    `invalid_cases`, `invalid_case`). So the page reads the file in the browser first, with the API's rules (`lib/eval-csv.ts`:
    the header, a row with the wrong number of values, an id that is not letters, digits, `_` or `-`, an id already in the
    suite, a criterion the suite does not measure, a case listed twice, a case the suite does not have, a value over 64 KB, more
    than 10,000 rows) and says "Read 42 rows with the columns case, output", then each row it would refuse by number ("Row 3
    names “plan-99”, which is not a case of this suite.") and that nothing is imported unless every row is accepted. Save is
    refused until the file reads clean. For results it also says how many of the suite's cases the file leaves without a row,
    because the API grades those as could not be graded, which counts as not passed. The API still decides: a file that reads
    clean can be refused, and then the dialog stays open with the file chosen and says why. **Nothing is shown as imported
    before the API answers**: cases are "Added 2 cases to “x”. It now has 12." from the suite the API returns; results are a run
    that is running until it finishes. A script or judge grader grades in the sandbox, which the dialog says.
  - **Customer content is text.** Case inputs and expected outputs, a model's or script's output, a grader's reason (a judge
    may quote the output), a suite or case name and an imported file's text are rendered as text nodes only, never as HTML or
    Markdown, in `<pre>` with the lines kept (`LongText`). One that is long (over about 240 characters or 5 lines) is folded
    with **Show the whole output (5,000 characters)** and **Fold the output**, and opens in a box that scrolls. A reason or
    output holding `<b>` or `**` shows those characters.
  - **Where the API serves no evals.** The API mounts the eval routes only when the sandbox gateway is configured; elsewhere
    they answer 404 with nothing in it (a mounted list never answers 404). The Proof card then says "Evals are not available
    in this environment, so a suite cannot be created, run or given results here. What the API already holds is shown." with
    the room's verdicts, no error and no buttons that cannot work, and the Eval suites card is not shown. A criterion nothing
    measures says **Not measured** there rather than "No eval suite".
  - **What it does not do.** No trend from the baseline (it is one number, measured before the work), no results from OpenTelemetry or JUnit (ADR 0006), no
    customer view of proof (the customer room), no editing or deleting a suite or a case (the API has neither), and no
    trend from before the page's runs (the API keeps only each criterion's latest value; the trend is read from the runs
    list, which carries every run's report and so every case's output: one read of it per visit, no polling of it, #76).
- **Board (project).** The project's tasks, one column per status: To do, In progress, Waiting on
  the customer, Blocked, Done. It replaces the old Tasks card and sits straight after the stage bar,
  not behind a tab: tasks are what an FDE touches all day, and a tab would hide them behind a
  click on every visit. A card has the title, its stage and who has it ("Evaluate · Assigned to Jonah
  Ade", the stage quiet and named "Stage:" to a screen reader; nothing for a task with none), the success criterion it works towards
  ("Towards: ...", whole and wrapped), why it is stuck (the
  blocker, or who it waits on and for how long) and when it is due; overdue and blocked get the
  amber dot.
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
  - **Moving.** Drag a card to another column, or to another place in its own: a 2px line in the
    tint, in the gap between two cards, shows where it lands (above a card when the pointer is in
    its upper half, below it past the middle, at the end below the last card), and the column a card
    comes into from another one is outlined as well. Or open its menu (the button in the card's corner,
    reachable by Tab and operated with the arrow keys and Enter) and pick **Move to** (the end of that
    column), **Move up** or **Move down** (one place; offered only where the card can go, and not in
    Done). The menu is the only way on a phone, and a card moved from it keeps the keyboard focus on
    its menu button, so the next move is one key away. A drop that leaves the card where it is sends
    nothing. A screen reader hears where it went: "Moved ... above ...".
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
  - **Order** in a column is the project's order, as the API lists the tasks (PR #190): a column is
    that order filtered by status. A move names its place as one other task of the column it goes to,
    `before` the top card or `after` the card above it; with no card there it names none and the API
    puts it at the end. A new task, or one moved to another column with no place, goes to the end, and
    any other save keeps its place. The API returns no position, so the page puts a confirmed move where
    those rules put it. A repeated identical move is a no-op on the API, version and all. Done is the
    exception: it lists the most recently finished first, because it is a record of what was finished
    and shows only the latest five, so it takes a drop but keeps no order of its own.
  - **A stale move within a column** (409 `stale_version`) is held like any other (see **A stale save**):
    the card takes the task as it now stands, and the note offers **Move it again**, the same place on the
    current version. The API returns no position, so the page cannot tell whether someone else already
    made the same move, and never says so.
  - **Create, edit, delete.** **New task** opens a form: title, status, the blocker or who it waits
    on when the status needs one, due date, who has it (unassigned, or anyone who works on the project,
    by name: see **People**), **Stage** (one of the eight, or "No stage"; beside Status, and a new task
    starts in the project's stage), and **Works towards**,
    one of the project's success criteria or none (not shown while the project has none). Clicking a
    card opens the same form.
  - **Every save sends the criterion and the stage back.** The API replaces `criterion` and `stage` on each
    save, as it does `assignee`, so a save that left one out would unlink the task or clear its stage.
    `toBody` returns `TaskSave`, whose replaced fields are all required, so no move, edit, prompt, Today
    action or the next step's form can drop one; unlinking is choosing "No success criterion" in the form,
    and clearing the stage is choosing "No stage". Removing a criterion unlinks its tasks (the API's
    `on delete set null`). **Delete task** asks first. A card says who has it: "Assigned to you",
    "Assigned to Jonah Ade" (whole, wrapped when long) or "Unassigned".
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
  - **A checklist guides; it does not trap.** Moving forward with everything met asks "Move this
    project to Access?" and goes. Moving forward with items open asks the same, and then lists what is
    open (an amber dot and "2 items are still open on Scope:", the labels as a list) and asks **Why are
    you moving on with these open?**: a field, required, counted against 500 ("0 / 500", the count
    turns red above it), under it "Your reason is recorded in the audit log, with the items left
    open." The button reads **Move with items open**. With no reason it says "Say why you are moving
    on with items open." and sends nothing; the same words for spaces only, and a refusal of more than
    500 characters or a control character, before the API is asked (`reasonProblem`, the API's own
    rule: trimmed, 1 to 500 characters, only newline and tab). The reason is sent trimmed. The note
    and any error describe the field; a screen reader hears the count ("7 of 500 characters") once
    typing pauses, not on every key.
  - **The confirmation stays open until the API answers** ("Moving…"), so a refusal keeps what was
    typed: `invalid_reason` reads "The reason is plain text, 1 to 500 characters."
  - **A stale view.** If the page thought nothing was open and the API answers 409
    `rejected_checklist_open`, the confirmation lists the items the API returned and asks for the
    reason then (the field takes focus), and the checklist reads again. If the API says items are open
    but names none, it still asks, under "Items are still open on Scope."
  - **Moving back never asks** for a reason and never sends one.

### The workspace (issue #209, behind a flag)

The first screens of the conversation-first workspace (`docs/direction.md` section 9, ADR 0008).
Off by default: the build flag `VITE_FDE_WORKSPACE=1` turns them on, and on the dev mock
`globalThis.__fdeMockWorkspace = true` (set before the app loads) does for one tab. With it on, the
sidebar has **Home** first, `/` is the welcome screen, every company is at `/companies`, and New
company opens `/new-company`. With it off, nothing changes and both new routes go back to `/`.
With it on, the screens work against the real API as well as the mock (issue #249): a new company
is saved in one setup call, and **Suggested next** is the API's home (`GET /v1/home`, issue #256).

- **Blocks.** The workspace shows only blocks from a fixed catalogue (`src/lib/workspace/blocks.ts`):
  suggestion, brief, plan, rules, people, checklist. Each has a zod schema; `parseBlocks` drops an
  unknown or malformed block, and `BlockView` draws nothing for a type it does not know. All text
  is drawn as React text, never as markup; a block may send a person only to one of our own
  screens, named (never a URL), and loads nothing from another host. A plan step is an ordinary
  task: a title, one of the eight stages, and, where it proves something, a success criterion with
  "How we will prove it" beside it (the place evals will fill).
- **Welcome** (`/`): the date and a greeting (the screen's heading); the conversation box, the
  centrepiece (Enter sends, Shift and Enter is a new line); two quiet prompts in one row ("Set up a
  new company", "What needs me today?"; full width, one under the other, on a phone); **Suggested
  next**, the API's home suggestions (at most five), each approved by opening where it is done or put away; and four
  companies with **See all**. One rhythm: 24px inside the opening, 48px between sections (40px on a phone), the
  same heading for each section, and the companies' tiles on the same edge as the cards above. Each
  suggestion reads where it comes from, then what (semibold), then why; the first one's approve is
  the screen's one primary button (ink), the others are outlined. Suggestions are fixed
  templates over names, counts and days waiting; they never quote a record's own text. The API
  sends a kind, counts, names and a route; the words for each kind are the web's own
  (`suggestionsFromHome` in `src/lib/workspace/welcome.ts`), names are shown as text, a kind the web
  does not know is skipped, and so is one whose route is not Today, a company or a project of ours.
  Loading is two quiet bars; an error says the day could not be read, with **Try again**. "Nothing
  needs you right now." only when the API sent none; when every one was put away or skipped it is
  "Nothing new to suggest right now.", and so is the scripted reply, since what is put away may
  still need the person. Each row's names carry where it is ("Not now: No next step, Acme ·
  Triage"; "Open the project: Acme · Triage"), so two of a kind are told apart. Putting one away is
  the one write applied before the API answers (it changes nothing anyone else sees, only this
  person's home): it leaves at once, focus moves to the next row's Not now (or the section's
  heading when none is left), and it comes back with a line naming it if the API refuses; a 404
  (already gone) counts as done. Several can be on their way at once: each failure brings back only
  its own row, and the home is read again only once none is pending. It stays away until the facts
  behind it change, so there is no Undo. A workspace with no company is offered **Set up a new
  company** instead. The
  scripted reply recognises a new company and the day's work, and says plainly what it cannot do.
- **New company** (`/new-company`): the workspace asks one step at a time (the company, its first
  project's name and what is delivered; how to start, the main contact and, optionally, one success
  criterion with how it is measured: what, at least or at most, a target and unit, and, behind
  **Add a baseline and how it will be proven** (open once either holds something), a baseline and
  how it will be proven; rules for agents and who approves; who to invite, optional;
  the plan; the review). Each answer fills a section of the **Summary** beside it (a sheet from **Summary** on
  a narrow screen). The plan is proposed from the answers (a call first, scope first, or a pilot)
  and can be reordered, renamed, added to and removed from, from one menu per step (the ⋯ button,
  so a phone's list stays a list of steps). Focus never falls to the page: after a move it stays on
  the step's menu button, after Remove it goes to the step that takes its place (or the one
  before, or the New step field), and after a rename is saved or left with Escape it returns to
  the step's menu button. The Summary is a digest, so the page has one focus: the company as label
  and value, a long value shortened to three lines with **Show more**; the plan as its count, how
  many steps prove a criterion and the first three, with **Show all**; the rules as a count per
  verdict and who approves, with **Show the rules**; and the people. A value is never dropped for
  its length: a block's limits are the forms' own, counted in characters as the forms count them.
  Any answer can be changed. The rules and people steps say they are not saved yet, and so do their
  sections of the summary. A plan step's criterion is the one given at the start (renamed or taken
  away with it, even on a changed plan), and its "How we will prove it" is what was typed, or "Not
  said yet"; nothing is made up for it. Real customer data is always "Never".
- **The review** says exactly what will be saved, drawn from the very body Create company sends
  (`setupBody`), never from the answers, so the screen shows the arguments themselves (ADR 0008):
  the company (and that the FDE becomes its lead), the first project and what is delivered, the
  main contact, the success criterion as it will read ("Met when ... Baseline ..."), and the plan as
  tasks in order with their stages. Under **Not saved yet** it lists the rules for agents, any
  invitations (by address) and, where a step names someone, who a step is with, as plain text with no
  control: each rule and invitation is confirmed on its own route (ADR 0008), not built yet.
  Nothing is saved until **Create company**, which sends one `POST /v1/companies/setup`
  (`setupBody` in `src/lib/workspace/setup.ts` maps the answers; an answer with no field is left
  out) and lands on the new project, its first step the next step.
  - **One key until it is settled.** The `Idempotency-Key` is made when the review first sends and
    held by the tab (`sessionStorage`) until the API answers it with a setup or a 409. Every send in
    between, whatever its body, goes under that key with that body's own bytes (never serialized
    again): a double click, Try again, a changed answer, leaving the review and coming back, or Back
    and Forward. After a lost answer, a 5xx or a request the page gave up on (30 seconds), no one
    knows whether the first send made a company; a 400, 401 or 403 that follows says nothing about
    it either, as the API refuses those before it claims a key. With the key held, the API answers
    409 `rejected_idempotency_key_reused` if the first landed (the screen says to check the
    companies first, and the next setup takes a new key) and makes it if it did not. Never two
    companies. A setup that answers after the page was left settles without taking anyone anywhere.
  - **A refused part** (a 400 `invalid_*`) is shown under that part of the review, with a link to the
    step that changes it; `invalid_name` is worked out from the names sent, in the API's order.
    A 401 keeps every answer and says to sign in again in another tab.
  - **Numbers** (target, baseline) are decimal only, as typed: digits, a point, a sign. A comma gets
    "Use a point for decimals, such as 1.5, and no commas."; `0x10`, `1e3` and the like are refused,
    never read as something else.

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
  deploy, `API_URL` in a dev build only. It refuses a write from another origin (`403 csrf`), refuses a
  body over 20 MiB (`413 payload_too_large`: it buffers a body to forward it, so a bound is kept, by
  the declared length and by counting a body that declares none), and answers `503` when it has no way
  to the API.
- The session is the API's HttpOnly cookie, set after AuthKit. No token is ever in JavaScript or
  browser storage. A 401 on any read or write sends the FDE to sign-in, coming back to the address
  they were at when it happened (`src/lib/session.ts`); `safeReturnTo` keeps that address a path
  on this origin.
- Ids are branded zod types with the platform's id rule (1 to 128 of `[A-Za-z0-9_-]`). Ids from
  the address bar are parsed before any call; a bad one shows "not available".
- Every project call takes a `ProjectScope` (company and project). The API answers 403 for a
  company or project that is not the FDE's and 404 for a missing record; the UI shows both as "not
  available", so it cannot tell "not yours" from "does not exist".
- Proof is `api.evalSuites`, `evalRuns`, `evalRun`, `createSuite`, `startEvalRun`, `importCases` and `importResults`
  (their own spec, `crates/oryxa-fde-agent/openapi.evals.json`, generated into `evals.gen.ts` and checked with the other two
  by `pnpm api:check`; schemas in `src/lib/api/evals.ts`, checked against it by `evals.test.ts`) and `api.room`, with
  `queries.evalSuites`, `evalRuns`, `evalRun` and `room`, all under the project's key. `importCases` and `importResults` send
  the file through `Transport.upload` like a document, and read the answer with zod. A 404 on a list means evals are not served
  (`evalsOff`).
- Documents are `api.documents`, `uploadDocument` (the one call written by hand around the generated client's
  `XMLHttpRequest` transport: the generated client sends no progress, and a raw file body is not JSON, but the answer
  is parsed with zod like every other) and `search`, with `queries.documents` and `queries.search`. A document's id,
  name and passages are never used as a path or markup; ids are parsed branded ids.
- Notes are `api.notes`, `addNote`, `updateNote` and `removeNote`, each taking a place (`{ company }` or
  `{ company, project }`) and choosing the company's or the project's routes (`queries.notes`, under the
  project's own key). A note's body is never rendered as markup anywhere.
- Records with a version (a task, an access request, a stakeholder, a system, a scope item, a criterion) carry it in
  every response; `schemas.ts` refuses one without it. `api.updateTask`, `updateAccess`, `updateStakeholder`,
  `updateSystem`, `updateScopeItem` and `updateCriterion` take the version of the copy the save is based on as their last
  argument, as does `signOffScope` (the scope's); a 409 `stale_version` throws a `StaleSaveError` carrying `current`.
- Writes are `api.createCompany`, `setUpCompany` (`POST /v1/companies/setup`, with the
  `Idempotency-Key` and the body's bytes as first sent, `SetupRequest`), `updateCompany` (a `PATCH`), `createProject`, `updateProject`,
  `addStakeholder`, `updateStakeholder`, `removeStakeholder`, `setMainContact`, the same three for systems,
  `addAccess` and `updateAccess` (the access request routes: there is no delete), `addDecision` (the log has no edit or
  remove), `accessRequests` and `threads` (read when a prompt or the decisions need them), `addScopeItem`, `updateScopeItem`, `removeScopeItem`, the same three for criteria, `signOffScope`, and
  `people` (`GET /v1/people`, `queries.people`), `members`, `setMember`, `removeMember`, `assignees`, `assign`, `unassign`, and `moveStage(scope, to, reason?)`
  with `stageChecklist(scope)`. A forward move that the API refuses for open items throws a
  `ChecklistOpenError`, which carries the items the API found open. The API's refusals carry a
  code only; `SAFE_TEXT` in `client.ts` turns the ones a person can act on into a sentence.
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
  in the mock and ships nowhere. The mock answers every write route of this page with the API's
  validation and permissions (meeting notes at a company and a project: the fields in the API's order, a `PUT`
  that replaces the note, attendees who work there and stakeholders who are at the company, 404 for a note that is not
  there; an access request starts requested or in progress, `blocked_by` is one of
  the project's, the decisions log takes no edit, and a decision's day is parsed as RFC 3339) (the scope's too: the version bump on every save, one sign-off per
  version, no sign-off of an empty scope) (a lead or admin manages, any member works, anything else is a 403)
  (#238's fields: a task's `stage` and a criterion's `baseline` and `proof` cleared by a `PUT` that leaves them out, a
  stage that is not one of the eight, or a baseline or proof of the wrong type, a 422 in plain text as axum's extractor
  answers, a blank, long or control-character proof a 400 `invalid_proof`; a project's `next_step` worked out on every
  read and Today's `projects_without_next_step`; one main contact per company, a stakeholder not the company's a 400
  `invalid_stakeholder`, and only the rows that change moving on a version):
  The mock answers the stage checklist and the stage move with the API's rules
  (`CHECKS` in `mock-api.ts`: the same keys, words and tests as `oryxa-fde-store`'s `checklist.rs`,
  worked out from the sample data: stakeholders, meeting notes (a count), the scope and its sign-off,
  access requests, eval suites and criterion results): a forward move with an item open and no reason
  is a 409 `rejected_checklist_open` with the open items, a reason that is not 1 to 500 trimmed
  characters is a 400 `invalid_reason` whenever it is sent, and moving back ignores it. Setting
  `globalThis.__fdeMockStaleChecklist = true` makes the checklist read every item as met until the
  first move that the API refuses for open items, so the stale-view refusal can be seen.
  The mock answers the eval routes and the room (`src/dev/mock-evals.ts`) with the API's rules: a suite for the project's own
  criteria with checked graders and commands (400 `invalid_suite`); cases and results from a CSV, all or none (400 `invalid_csv`,
  `invalid_cases`, `invalid_case`; 409 `rejected_no_target`, `rejected_no_cases`); a run that is `running` until its time has come
  (5 seconds in a dev build, `globalThis.__fdeMockEvalMs`; worked out when it is read), then graded by each grader with errored
  cases counting as not passed; a criterion's value `passed / total` over the cases that measure it, left alone by a run in which
  none does; and the room's `passing` as the API judges it, which the stage checklist's two eval items share.
  `globalThis.__fdeMockEvalsOff = true` makes every eval route answer 404, as where no sandbox gateway is set. The seeds are
  invented: Kestrel's dispatch project has a criterion met from imported results, one not met from runs in the sandbox with a case
  that errored, and one with a suite not yet run; Lumen's forecast is met but three weeks old and has a criterion no suite measures.
  The mock answers a company's documents and search (`src/dev/mock-documents.ts`) with the API's rules: a raw
  body of text, Markdown, PDF or DOCX with its `Content-Type`, up to 20 MiB, not empty (413, 415 and 400 as the API
  answers); a document is `pending` after an upload and becomes `ingested` or `failed` after a moment (4 seconds in a
  dev build, set with `globalThis.__fdeMockIngestMs`), worked out when it is read so no timer runs; a name that holds
  `unreadable` fails as `unreadable`, and a text file with nothing in it as `empty`; a search finds whole words (and
  their stems), "phrases" and -exclusions in the passages of ingested documents only, with the API's checks on `q` and
  `limit`. `globalThis.__fdeMockStallUpload = true` sends 60% of a file and waits, so the progress bar can be seen. The
  mock cannot take an upload through `fetch` in a jsdom test, so `Transport.upload` hands it the file.
  The mock versions its records as the API does: a version from 1, moved on by every change, the engine-style ones the
  mock simulates included (an unblocked task, a removed stakeholder's tasks and requests), an identical save answered as it
  is, a stale `version` a 409 `stale_version` with `current` (the whole scope for a sign-off), and a `version` on a
  create a 400 `invalid_version`. `globalThis.__fdeMockSomeoneElse = true` makes someone else change the record the next
  versioned save is about, once, just before it is checked (an object is the change to make, such as `{ status: "done" }`),
  so a stale save can be seen and tested.
  The mock answers `POST /v1/companies/setup` as the API does (`setUp` in `mock-api.ts`): the key
  checked, a body serde would not read (an unknown field at any level, a wrong type or enum) a 400
  `invalid_body`, the lists' limits and the places they name, then every part through its own route
  here with that route's rules, all or nothing (a refused setup leaves nothing and claims no key);
  the key claimed by caller and key, the same key and bytes answered with that setup as it stands
  (200, or 403 if it can no longer be seen), and other bytes a 409 `rejected_idempotency_key_reused`.
  With two parts wrong it may name another one first than the API, which checks all before writing.
  `globalThis.__fdeMockRefuseSetup = "forbidden"` refuses the next setup once with that code (a 403 for
  `forbidden`, a 400 for any other), so a refused setup can be seen.
  The mock answers `/v1/people` from its invented directory as the API does (the organisation's own people by
  name, the unnamed last, no guest, no email), names members and assignees when it answers them, adds only
  someone of the organisation to a company (404 otherwise), and takes a task's assignee or a note's attendee
  only from those who work on the place. Its sample people include a long name and one with no name.
  `globalThis.__fdeMockPeople = "unavailable"` makes WorkOS unreachable (`/v1/people` answers 503, and members
  and assignees carry no names), and `"forbidden"` makes `/v1/people` answer 403.
  `resetMockApi({ engineer: true })` signs in as an engineer, `{ empty: true }` leaves no company,
  and `globalThis.__fdeMockNoCompanies = true` before the app loads does the same in the browser. It exists only in a dev build with `VITE_FDE_MOCK_API=1`;
  `mock-excluded.test.ts` and CI prove a production build leaves it out. Tests run against the
  same mock.

## 5. Looking at a screen

Every PR that changes a screen is looked at before it goes to review, and lists its screenshots in
the PR text. `pnpm shots` does it in one command: it renders the screens in `scripts/shots/screens.mjs`
on `pnpm dev:mock` (it uses one already running at `http://127.0.0.1:3000`, or starts and stops its own,
with our own sign-in screens on; start yours with `VITE_FDE_OWN_SIGN_IN=1` to photograph them)
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
  `failWrites: true` makes the mock refuse every write, to see the failed-save states;
  `emptyWorkspace: true` starts a workspace with no company; `workspace: true` turns the new workspace on for that screen (the mock's `__fdeMockWorkspace`); `pendingStep` starts a sign-in waiting at
  that step, as Google's callback leaves it; `evalsOff: true` makes the eval routes answer 404 (the mock's `__fdeMockEvalsOff`, set before the app loads); `people: "unavailable"` or `"forbidden"` makes `/v1/people` answer 503 or 403 (the mock's `__fdeMockPeople`); `staleChecklist: true` makes the project's
  checklist read as all met until the first refused move (the mock's `__fdeMockStaleChecklist`). A screen that shows a stale save sets the mock's `__fdeMockSomeoneElse` from its `act`, between opening a form and saving it (`someoneElse` in `screens.mjs`). `sizes` and
  `themes` narrow an entry. The file's header lists every option.
- Look at the shots, in both themes and at 390 wide, before asking for review; say in the PR what you
  checked and what you changed because of it.

## 6. States and copy

- Every read shows loading, empty and error states; errors offer Try again. Today never claims an
  all clear unless the API answered.
- Never imply a connection or a finished action before the API confirms it. A write is never
  applied to the screen first and undone on failure: the screen shows it pending, then confirmed.
  The one exception is putting away a home suggestion, which changes nothing anyone
  else sees, only this person's home (see **Welcome**).
- Plain, short sentences in sentence case. No em dashes anywhere: UI copy, docs and comments. No
  exclamation marks.
