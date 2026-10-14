# Forge window (web-app)

React + TypeScript + Vite. `npm run build:ui` bundles it into one HTML file at `mcp-server/forge_core/static/workbench.html`
(served as the MCP Apps resource `ui://forge/workbench` and at `/ui`). `npm run build:host` builds the test host harness.
`npm test` runs the unit tests (vitest). The in-browser app compiler lives in `src/preview/`.
