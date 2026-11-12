import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// shadcn's base-nova button on Base UI, on the tokens in styles.css. Written by hand: the shadcn
// registry is not reachable from every build environment.
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-[background-color,color,border-color,transform] duration-150 select-none disabled:pointer-events-none disabled:opacity-45 motion-safe:active:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/75",
        outline:
          "border border-border bg-transparent text-soft hover:bg-selected hover:text-foreground",
        ghost: "text-soft hover:bg-selected hover:text-foreground",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 px-3",
        /** The one primary action of a workspace screen. */
        lg: "h-10 px-5 text-[13px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

type ButtonProps = Omit<ButtonPrimitive.Props, "className"> &
  VariantProps<typeof buttonVariants> & { className?: string }

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
