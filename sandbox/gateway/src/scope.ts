// Same id rules as oryxa-core and oryxa-fde-core: ids reach Durable Object names, labels and logs.
const ID_CHARS = /^[A-Za-z0-9_-]+$/;
const TENANT_MAX = 64;
const COMPANY_MAX = 128;

declare const brand: unique symbol;
export type TenantId = string & { readonly [brand]: "TenantId" };
export type CompanyId = string & { readonly [brand]: "CompanyId" };

/** Every company-scoped call takes one, so no sandbox, policy or secret is reached without both ids. */
export interface CompanyScope {
  readonly tenant: TenantId;
  readonly company: CompanyId;
}

export class ScopeError extends Error {
  override readonly name = "ScopeError";
}

export function companyScope(tenant: string, company: string): CompanyScope {
  if (!validId(tenant, TENANT_MAX)) throw new ScopeError("tenant id must be 1..=64 chars of [A-Za-z0-9_-]");
  if (!validId(company, COMPANY_MAX)) throw new ScopeError("company id must be 1..=128 chars of [A-Za-z0-9_-]");
  return Object.freeze({ tenant: tenant as TenantId, company: company as CompanyId });
}

/** The company's sandbox Durable Object. `:` is outside the id charset, so two scopes never share a name. */
export function sandboxName(scope: CompanyScope): string {
  return `${scope.tenant}:${scope.company}`;
}

function validId(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && ID_CHARS.test(value);
}
