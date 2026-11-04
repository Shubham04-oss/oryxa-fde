# fde-web

The FDE workspace's web app: TanStack Start on Cloudflare Workers, with the platform web app's
stack and versions. Read [DESIGN.md](DESIGN.md) before changing a screen.

```bash
corepack enable    # pnpm at the version and hash package.json pins
pnpm install --frozen-lockfile
pnpm dev:mock      # every screen on invented sample data, no backend: http://localhost:3000
pnpm api:check && pnpm typecheck && pnpm lint && pnpm check && pnpm test && pnpm build
```

- `pnpm dev` runs without the mock: the Worker forwards `/api/*` and `/auth/*` to a local
  `oryxa-fde-api` at `API_URL` (`wrangler.jsonc`, `http://localhost:8080`). Run the API with
  `WEB_ORIGIN=http://localhost:3000`, and register `http://localhost:3000/auth/callback` as a
  redirect URI in WorkOS, so AuthKit brings you back here signed in.
- When the API's `openapi.json` changes, run `pnpm api:generate` and make `schemas.ts` follow it:
  `pnpm typecheck` says where.
- On the mock, sign-in is simulated and kept for the browser tab. To see sign-in again, sign out
  from the profile menu.
- Do not run `wrangler deploy`: deployment comes with the infra stream.
