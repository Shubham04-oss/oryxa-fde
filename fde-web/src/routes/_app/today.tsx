import { createFileRoute } from "@tanstack/react-router"
import { TodayView } from "@/components/today-view"

export const Route = createFileRoute("/_app/today")({ component: () => <TodayView /> })
