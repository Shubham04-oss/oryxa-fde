// Every way out of `src/` to the runtime's unguarded fetch (issue #267). Each must be refused by eslint; see
// eslint.config.js. Never imported or run.

// eslint-disable-next-line no-restricted-syntax
import { runtime } from "../../src/model/provider.js";
// eslint-disable-next-line no-restricted-syntax
import { runtime as renamed } from "../../src/model/provider.js";
import * as provider from "../../src/model/provider.js";

// eslint-disable-next-line no-restricted-syntax
export const direct = () => runtime.fetch("https://outbound.example/");
// Refused at its import above: a destructure names no `runtime` itself.
export const destructured = () => {
  const { fetch: f } = renamed;
  return f;
};
// eslint-disable-next-line no-restricted-syntax
export const namespaced = () => provider.runtime;
// eslint-disable-next-line no-restricted-syntax
export const computed = () => provider["runtime"];
