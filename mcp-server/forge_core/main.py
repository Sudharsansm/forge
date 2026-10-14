from __future__ import annotations

import logging
import sys

from . import config


def run() -> None:
    """Start the HTTP API + web socket + MCP endpoint (http://HOST:PORT/mcp)."""
    import uvicorn

    logging.basicConfig(level=config.LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)

    if config.HOST not in ("127.0.0.1", "localhost", "::1") and not config.API_KEY:
        print("Refusing to listen on a public address without FORGE_API_KEY set.", file=sys.stderr)
        raise SystemExit(2)
    print(f"Forge API   : http://{config.HOST}:{config.PORT}/api/health", file=sys.stderr)
    print(f"MCP (HTTP)  : http://{config.HOST}:{config.PORT}/mcp", file=sys.stderr)
    print("Storage     : none - projects live in memory only and the app is compiled inside the Forge window", file=sys.stderr)
    uvicorn.run("forge_core.api:app", host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    run()
