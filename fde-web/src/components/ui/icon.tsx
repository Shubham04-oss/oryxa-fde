import {
  ArrowRightIcon,
  ArrowUpIcon,
  BuildingApartmentTwoIcon,
  BurgerMenuThreeIcon,
  CalendarCheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FileIcon,
  FolderIcon,
  HomeSimpleIcon,
  LaptopIcon,
  LogOutRightIcon,
  MoonIcon,
  MultipleCrossCancelIcon,
  PencilEditIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  SidebarMenuIcon,
  SparkleAi01Icon,
  SunIcon,
  ThreeDotsMenuHorizontalIcon,
  UserIcon,
  UserPlusIcon,
} from "@pikaicons/core-free"
import type { IconSvgElement } from "@pikaicons/core-free"
import { PikaIcon } from "@pikaicons/react"
import { Check } from "lucide-react"
import type { SVGProps } from "react"

// Every icon in the app comes through here, so the set can be swapped in one file (DESIGN.md §1).
// Pikaicons' free set (MIT) first; lucide only where the free set has nothing that fits.
const PIKA = {
  "arrow-right": ArrowRightIcon,
  "arrow-up": ArrowUpIcon,
  building: BuildingApartmentTwoIcon,
  "calendar-check": CalendarCheckIcon,
  "chevron-down": ChevronDownIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-up": ChevronUpIcon,
  close: MultipleCrossCancelIcon,
  file: FileIcon,
  home: HomeSimpleIcon,
  menu: BurgerMenuThreeIcon,
  more: ThreeDotsMenuHorizontalIcon,
  pencil: PencilEditIcon,
  person: UserIcon,
  moon: MoonIcon,
  plus: PlusIcon,
  project: FolderIcon,
  rules: ShieldCheckIcon,
  search: SearchIcon,
  sidebar: SidebarMenuIcon,
  sign_out: LogOutRightIcon,
  sparkle: SparkleAi01Icon,
  sun: SunIcon,
  system: LaptopIcon,
  "user-plus": UserPlusIcon,
} satisfies Record<string, IconSvgElement>

// ponytail: Pikaicons' free set has no bare tick (only one in a circle or a square); listed in the PR for #209.
const LUCIDE = { check: Check } as const

export type IconName = keyof typeof PIKA | keyof typeof LUCIDE

type IconProps = Omit<SVGProps<SVGSVGElement>, "ref" | "children"> & {
  name: IconName
  /** Width and height in pixels. */
  size?: number
  strokeWidth?: number
}

/** An icon, hidden from screen readers: the control around it carries the words. */
export function Icon({ name, size = 16, strokeWidth = 1.75, ...rest }: IconProps) {
  if (name in LUCIDE) {
    const Lucide = LUCIDE[name as keyof typeof LUCIDE]
    return <Lucide size={size} strokeWidth={strokeWidth} aria-hidden="true" {...rest} />
  }
  return (
    <PikaIcon
      icon={PIKA[name as keyof typeof PIKA]}
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden="true"
      focusable="false"
      {...rest}
    />
  )
}
