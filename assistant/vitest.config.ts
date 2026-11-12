import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { fakeApi } from "./test/fake-api.js";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Sample values only; real ones are Worker secrets.
        bindings: {
          SERVICE_TOKEN: "sample-service-token-for-tests-0123456789",
          BINDING_KEY: "sample-binding-key-for-tests-0123456789ab",
        },
        // The API binding, answered in Node by the sample API.
        serviceBindings: { API: fakeApi },
        // Any other request leaving the Worker is refused here, and test/outbound.test.ts asserts none is made.
        outboundService: () => new Response("outbound requests are not allowed", { status: 599 }),
      },
    }),
  ],
});
