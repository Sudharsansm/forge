// Copy the single-file build next to the Python server so it can serve it as the ui:// resource.
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, "../dist/index.html");
const to = resolve(here, "../../mcp-server/forge_core/static/workbench.html");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`workbench.html -> ${to} (${Math.round(statSync(to).size / 1024)} KB)`);
