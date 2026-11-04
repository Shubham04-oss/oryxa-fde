import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Sample values only; real ones are Worker secrets.
const DEV_SECRETS = {
  "org_a/cmp_1": { github: "sample-github-token-company-a" },
  "org_b/cmp_1": { github: "sample-github-token-company-b" },
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SERVICE_TOKEN: "sample-service-token-for-tests-0123456789",
          DEV_SECRETS: JSON.stringify(DEV_SECRETS),
        },
      },
    }),
  ],
});
