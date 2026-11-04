// A run's address, with the platform's id rules: ids reach Durable Object names.
const ID = /^[A-Za-z0-9_-]+$/;

export interface RunAddress {
  readonly tenant: string;
  readonly company: string;
  readonly project: string;
  readonly run: string;
}

const valid = (value: string | undefined, max: number): value is string =>
  value !== undefined && value.length > 0 && value.length <= max && ID.test(value);

/**
 * The run in `/internal/v1/tenants/<t>/companies/<c>/projects/<p>/agent-runs/<r>/<action>`, and the action, or
 * null for any other path or a bad id. Not URI-decoded: an encoded `/` or `:` stays in and is refused.
 */
export function parseRunPath(pathname: string): { address: RunAddress; action: string } | null {
  const parts = pathname.split("/");
  const [empty, internal, version, tenants, tenant, companies, company, projects, project, runs, run, action] = parts;
  if (parts.length !== 12 || empty !== "" || internal !== "internal" || version !== "v1") return null;
  if (tenants !== "tenants" || companies !== "companies" || projects !== "projects" || runs !== "agent-runs") {
    return null;
  }
  if (!valid(tenant, 64) || !valid(company, 128) || !valid(project, 128) || !valid(run, 128)) return null;
  if (action === undefined) return null;
  return { address: Object.freeze({ tenant, company, project, run }), action };
}

/** The run's object. `:` is outside the id charset, so two runs never share a name. */
export function channelName(address: RunAddress): string {
  return `${address.tenant}:${address.company}:${address.project}:${address.run}`;
}
