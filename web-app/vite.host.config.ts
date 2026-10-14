import { defineConfig } from "vite";
// Builds the MCP test host harness (not shipped to users): npm run build:host
export default defineConfig({ root: "host-test", base: "./", build: { outDir: "../dist-host", emptyOutDir: true, target: "es2022" } });
