import handler from "@tanstack/react-start/server-entry"
import { withSecurityHeaders } from "./security-headers"

// The Worker (wrangler.jsonc `main`). It serves the app through TanStack Start, and every answer
// leaves through one place that sets the security headers. It forwards nothing yet: the API is
// reached over a private link once it exists (ADR 0003), and the app runs on the mock until then.

export default {
  async fetch(request) {
    return withSecurityHeaders(await handler.fetch(request), request)
  },
} satisfies ExportedHandler
