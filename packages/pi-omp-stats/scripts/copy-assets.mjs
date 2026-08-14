// Copy non-TS assets (dashboard.html) next to the compiled JS in dist/.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
mkdirSync(resolve(root, "dist"), { recursive: true });
copyFileSync(resolve(root, "src", "dashboard.html"), resolve(root, "dist", "dashboard.html"));
console.log("copied src/dashboard.html -> dist/dashboard.html");
