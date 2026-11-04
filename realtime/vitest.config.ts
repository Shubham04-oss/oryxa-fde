import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Sample values only; real ones are Worker secrets.
        bindings: {
          PUBLISH_TOKEN: "sample-publish-token-for-tests-0123456789",
          SUBSCRIBE_TOKEN: "sample-subscribe-token-for-tests-012345",
        },
      },
    }),
  ],
});
