//  @ts-check

/** @type {import("prettier").Config} */
export default {
  semi: false,
  printWidth: 100,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "./src/styles.css",
}
