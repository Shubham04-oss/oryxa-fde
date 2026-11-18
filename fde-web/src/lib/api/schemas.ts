import { z } from "zod"

// The FDE API's answers, following its OpenAPI spec (crates/oryxa-fde-api/openapi.json, generated
// into fde-api.gen.ts). Every answer is parsed against these, so an API or mock that drifts fails
// loudly at runtime; schemas.test.ts fails the typecheck when one stops matching the spec.

/**
 * An id, with the rule `oryxa-core` enforces: 1 to `max` of [A-Za-z0-9_-]. Branded, so a raw
 * string cannot reach a call without being checked.
 */
function id<TBrand extends string>(max = 128) {
  return z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`))
    .brand<TBrand>()
}

export const TenantId = id<"TenantId">(64)
export const UserId = id<"UserId">(64)
export type UserId = z.infer<typeof UserId>

/** Who is signed in: `GET /v1/me` (the spec's `MeOut`). */
export const Me = z.object({
  user: z.object({ id: UserId, name: z.string() }),
  organisation: z.object({ id: TenantId, name: z.string() }),
  role: z.enum(["admin", "member"]),
})
export type Me = z.infer<typeof Me>
