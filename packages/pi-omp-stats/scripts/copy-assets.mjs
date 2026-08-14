// Copy non-JS assets (dashboard.html) next to the compiled JS in dist/, and
// ensure the CLI bin is executable.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
mkdirSync(resolve(root, "dist"), { recursive: true });
copyFileSync(resolve(root, "src", "dashboard.html"), resolve(root, "dist", "dashboard.html"));
console.log("copied src/dashboard.html -> dist/dashboard.html");

// `tsc` does not preserve the executable bit from `src/index.ts`, but the npm
// `bin` symlink invokes `dist/index.js` directly via its `#!/usr/bin/env node`
// shebang. Without +x the global `pi-omp-stats` command fails with
// "Permission denied", so force it after every build.
const indexJs = resolve(root, "dist", "index.js");
if (existsSync(indexJs)) {
  chmodSync(indexJs, 0o755);
  console.log("chmod +x dist/index.js");
}
