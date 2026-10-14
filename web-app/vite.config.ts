import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Production build = ONE html file (the MCP App resource). `npm run dev` = standalone mode against the Forge API.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { target: "es2022", chunkSizeWarningLimit: 3000 },
  server: { port: 3000, proxy: { "/api": "http://127.0.0.1:8000" } },
});
