import type { QueryClient } from "@tanstack/react-query"
import { HeadContent, Link, Scripts, createRootRouteWithContext } from "@tanstack/react-router"
import { themeBootScript } from "@/lib/theme"
import appCss from "../styles.css?url"

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Oryxa FDE" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: () => (
    <main className="grid min-h-dvh place-content-center gap-2 bg-canvas p-6 text-center text-[13px]">
      <h1 className="text-base font-semibold">Page not found</h1>
      <Link to="/" className="underline underline-offset-2">
        Go to your companies
      </Link>
    </main>
  ),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The boot script may set data-theme before React hydrates, so the attribute can differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
