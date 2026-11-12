// @ts-check
import tseslint from "typescript-eslint";

// Two of the assistant's rules, checked in its code as well as by its tests (issue #236): it reaches no host but
// the API binding, so `src/` has no global `fetch` or sockets; and its logs carry ids only, so the one console call
// allowed is a `warn` of ids (conversation.ts).
export default tseslint.config(
  { ignores: ["node_modules/", ".wrangler/", "src/catalogue/"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Outbound requests go through the API binding only (src/tools.ts)." },
        { name: "WebSocket", message: "Outbound requests go through the API binding only (src/tools.ts)." },
        { name: "EventSource", message: "Outbound requests go through the API binding only (src/tools.ts)." },
      ],
      "no-restricted-imports": [
        "error",
        { name: "cloudflare:sockets", message: "Outbound connections go through the API binding only." },
      ],
      "no-console": ["error", { allow: ["warn"] }],
    },
  },
);
