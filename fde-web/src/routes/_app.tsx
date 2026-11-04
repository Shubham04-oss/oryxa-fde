import { Outlet, createFileRoute } from "@tanstack/react-router"
import { SessionGate } from "@/components/session-gate"

export const Route = createFileRoute("/_app")({ component: AppLayout })

function AppLayout() {
  return (
    <SessionGate>
      <Outlet />
    </SessionGate>
  )
}
