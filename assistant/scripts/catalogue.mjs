// Copies the web's block catalogue and wire format into this Worker (issue #236), so the Worker checks
// what it sends with the very schemas the web checks before it renders. `--check` fails when a copy is
// stale: after changing either file in fde-web, run `npm run catalogue` here and commit both.
import { readFileSync, writeFileSync } from "node:fs";

const FILES = ["blocks.ts", "wire.ts"];
const source = new URL("../../fde-web/src/lib/workspace/", import.meta.url);
const target = new URL("../src/catalogue/", import.meta.url);
const check = process.argv.includes("--check");

const stale = [];
for (const name of FILES) {
  const want = `// Generated from fde-web/src/lib/workspace/${name} by \`npm run catalogue\`. Do not edit.\n\n${readFileSync(new URL(name, source), "utf8")}`;
  if (!check) {
    writeFileSync(new URL(name, target), want);
    continue;
  }
  let have = null;
  try {
    have = readFileSync(new URL(name, target), "utf8");
  } catch {
    // A missing copy is stale.
  }
  if (have !== want) stale.push(name);
}
if (stale.length > 0) {
  console.error(`src/catalogue is out of date (${stale.join(", ")}): run \`npm run catalogue\`.`);
  process.exit(1);
}
