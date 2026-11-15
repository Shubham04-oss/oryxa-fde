// @ts-check
import tseslint from "typescript-eslint";

// Two of the assistant's rules, checked in its code as well as by its tests (issue #236): it reaches no host but
// the API binding, so `src/` has no global `fetch` or sockets; and its logs carry ids only, so the one console call
// allowed is a `warn` of ids (conversation.ts).
export default tseslint.config(
  { ignores: ["node_modules/", ".wrangler/", "src/catalogue/"] },
  ...tseslint.configs.recommended,
  {
    // test/lint/ holds uses each rule must refuse, every one marked with a disable comment: a rule that stops
    // firing leaves its comment unused, which is an error, so `npm run check` fails.
    files: ["src/**/*.ts", "test/lint/**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
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
      // `runtime.fetch` is the unguarded runtime fetch: only the module that guards it may touch it (issue #267).
      // Importing `runtime` is refused too, so a rename, a namespace or a destructure cannot reach it either.
      "no-restricted-syntax": [
        "error",
        ...[
          'MemberExpression[object.name="runtime"]',
          'MemberExpression[property.name="runtime"]',
          'MemberExpression[property.value="runtime"]',
          'ImportSpecifier[imported.name="runtime"]',
          'ExportSpecifier[local.name="runtime"]',
          'ObjectPattern > Property[key.name="runtime"]',
          'ObjectPattern > Property[key.value="runtime"]',
        ].map((selector) => ({
          selector,
          message: "The runtime's own fetch is unguarded; only src/model/provider.ts uses it.",
        })),
      ],
    },
  },
  { files: ["src/model/provider.ts"], rules: { "no-restricted-syntax": "off" } },
);
