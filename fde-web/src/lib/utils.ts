import { clsx } from "clsx"
import type { ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Our type scale (styles.css @theme) as font sizes: without it, `text-meta` beside a text colour
// reads as a colour and is dropped.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "micro",
            "meta",
            "body",
            "lead",
            "title",
            "display",
            "r2-page",
            "r2-body",
            "r2-meta",
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: Array<ClassValue>) {
  return twMerge(clsx(inputs))
}
