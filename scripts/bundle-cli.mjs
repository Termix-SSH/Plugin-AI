// Copies the Termix CLI's single-file bundle next to dist/backend.js, so it
// ships inside the .tmxplug. It bundles its own dependencies; keytar is an
// optional import the CLI does without. Runs after termix-plugin build, which
// empties dist first.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const source = require.resolve("@termix-ssh/cli/dist/index.js");
const target = path.resolve("dist/vendor/termix-cli.mjs");

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`bundled ${path.relative(process.cwd(), target)}`);
