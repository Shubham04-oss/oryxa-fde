# fde-web

The FDE workspace's web app: TanStack Start on Cloudflare Workers, with the platform web app's
stack and versions. Read [DESIGN.md](DESIGN.md) before changing a screen.

```bash
pnpm install --frozen-lockfile
pnpm dev:mock      # every screen on invented sample data, no backend: http://localhost:3000
pnpm typecheck && pnpm lint && pnpm check && pnpm test && pnpm build
```

- `pnpm dev` runs without the mock. Until the API is connected (wave 2) every screen shows its
  error state there.
- On the mock, sign-in is simulated and kept for the browser tab. To see sign-in again, sign out
  from the profile menu.
- Do not run `wrangler deploy`: deployment comes with the infra stream.
