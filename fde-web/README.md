# fde-web

The FDE workspace's web app: TanStack Start on Cloudflare Workers, with the platform web app's
stack and versions. Read [DESIGN.md](DESIGN.md) before changing a screen.

```bash
corepack enable    # pnpm at the version and hash package.json pins. Node 25 and later ship no corepack:
                   # run `npm install --global corepack` first.
pnpm install --frozen-lockfile
pnpm dev:mock      # every screen on invented sample data, no backend: http://localhost:3000
pnpm shots         # PNGs of the screens, light and dark, three widths (needs Docker; see DESIGN.md, section 5)
pnpm api:check && pnpm typecheck && pnpm lint && pnpm check && pnpm test && pnpm build
```

- `pnpm dev` runs without the mock: the Worker forwards `/api/*` and `/auth/*` to a local
  `oryxa-fde-api` at `API_URL` (`wrangler.jsonc`, `http://localhost:8080`). Run the API with
  `WEB_ORIGIN=http://localhost:3000`, and register `http://localhost:3000/auth/callback` as a
  redirect URI in WorkOS, so AuthKit brings you back here signed in.
- When the API's `openapi.json` changes, run `pnpm api:generate` and make `schemas.ts` follow it:
  `pnpm typecheck` says where.
- Our own sign-in screens (ADR 0007) are off by default, and `/sign-in` keeps today's redirect to
  `/auth/login`. Turn them on at build time with `VITE_FDE_OWN_SIGN_IN=1`
  (`VITE_FDE_OWN_SIGN_IN=1 pnpm dev:mock`, or the same variable for `pnpm build`). On the mock, sign in as `riya@example.com` with
  `sample-password`; the other sample accounts are listed in `src/dev/mock-sign-in.ts`. Turn it on in
  a deployed build only once the API's sign-in routes are there.
- The new workspace (issue #209: the welcome screen and a new company made in a conversation) is off
  by default. Turn it on at build time with `VITE_FDE_WORKSPACE=1` (`VITE_FDE_WORKSPACE=1 pnpm dev:mock`).
  Its conversation box talks to the assistant Worker (`assistant/`, issue #236) through `/assistant/*`
  (`src/assistant.ts`) once the Worker has the `ASSISTANT` service binding and the secrets
  `ASSISTANT_SERVICE_TOKEN` and `ASSISTANT_BINDING_KEY`; without them, and on the mock, it answers from
  its script.
- `src/lib/workspace/blocks.ts` and `wire.ts` are copied into the assistant Worker, which checks what it
  sends with them. After changing either, run `npm run catalogue` in `assistant/` and commit the copies.
- On the mock, sign-in is simulated and kept for the browser tab. To see sign-in again, sign out
  from the profile menu.
- Do not run `wrangler deploy`: deployment comes with the infra stream.
