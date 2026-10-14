# UNTESTED: written to show the deployment shape. Build/run it yourself and expect to adjust it.
# Forge needs no Node at run time: apps are compiled inside the browser window. Node is only used here to build the window.
FROM node:22-bookworm-slim AS ui
WORKDIR /app
COPY web-app web-app
COPY mcp-server/forge_core/static mcp-server/forge_core/static
RUN npm install --prefix web-app && npm run build:ui --prefix web-app

FROM python:3.13-slim
RUN pip install --no-cache-dir uv
WORKDIR /app
COPY mcp-server mcp-server
COPY --from=ui /app/mcp-server/forge_core/static mcp-server/forge_core/static
RUN uv sync --directory mcp-server --no-dev && useradd -m forge && chown -R forge /app
USER forge
ENV FORGE_HOST=0.0.0.0
EXPOSE 8000
# Refuses to start on 0.0.0.0 unless FORGE_API_KEY is set.
CMD ["uv", "run", "--directory", "mcp-server", "forge-server"]
