"""Security layer: API-key auth, Host-header guard (DNS rebinding), body limits, response headers, env scrubbing.

Everything here is plain ASGI so it also wraps the mounted MCP endpoint.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import config

log = logging.getLogger("forge.security")

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


# ---------------------------------------------------------------------------------------------- environment
# Variables a project's build / dev server may see. Everything else (API keys, tokens, cloud credentials) is dropped.
_ENV_KEEP = {
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "SYSTEMDRIVE",
    "COMSPEC", "PATHEXT", "NODE_OPTIONS", "LANG", "LC_ALL", "TERM",
    # proxies / certificates: npm must still reach its registry behind a corporate proxy
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
}
_ENV_KEEP_LOWER = {k.lower() for k in _ENV_KEEP}


def clean_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """A scrubbed copy of os.environ for running untrusted project code (npm, vite)."""
    env = {k: v for k, v in os.environ.items()
           if k.lower() in _ENV_KEEP_LOWER or k.lower().startswith("npm_config_")}
    env.update(extra or {})
    return env


# ---------------------------------------------------------------------------------------------- hosts
def allowed_hosts() -> set[str]:
    hosts = set(LOCAL_HOSTS)
    hosts.update(h.strip().lower() for h in config.ALLOWED_HOSTS if h.strip())
    if config.PUBLIC_URL:
        netloc = urlparse(config.PUBLIC_URL).hostname
        if netloc:
            hosts.add(netloc.lower())
    return hosts


def host_guard_enabled() -> bool:
    """DNS-rebinding protection matters when anything on the server answers without a secret.
    With FORGE_API_KEY set a rebinding page cannot authenticate, so the guard is only forced on by FORGE_ALLOWED_HOSTS."""
    return (not config.API_KEY) or bool(config.ALLOWED_HOSTS)


def _host_only(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("["):  # [::1]:8000
        return value.split("]", 1)[0] + "]"
    return value.split(":", 1)[0]


def safe_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# ---------------------------------------------------------------------------------------------- middlewares
async def _json(send: Send, status: int, body: dict, extra: list[tuple[bytes, bytes]] | None = None) -> None:
    payload = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode()), *(extra or [])]})
    await send({"type": "http.response.body", "body": payload})


class HostGuardMiddleware:
    """Reject requests whose Host header is not one we expect (blocks DNS-rebinding attacks on a local server)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket") and host_guard_enabled():
            headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope["headers"]}
            host = _host_only(headers.get("host", ""))
            if host not in allowed_hosts():
                log.warning("rejected request with unexpected Host header %r", host)
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4403})
                else:
                    await _json(send, 421, {"error": "Unexpected Host header. Set FORGE_ALLOWED_HOSTS or FORGE_PUBLIC_URL."})
                return
        await self.app(scope, receive, send)


class BodyLimitMiddleware:
    """Refuse oversized request bodies before they are read into memory."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            for k, v in scope["headers"]:
                if k == b"content-length":
                    try:
                        too_big = int(v) > config.MAX_BODY_BYTES
                    except ValueError:
                        too_big = True
                    if too_big:
                        await _json(send, 413, {"error": f"Request body is larger than {config.MAX_BODY_BYTES // 1_000_000} MB"})
                        return
        await self.app(scope, receive, send)


class ApiKeyMiddleware:
    """If FORGE_API_KEY is set, /api, /ws and /mcp need it: `Authorization: Bearer`, `X-API-Key`, or (WebSocket only) `?token=`.
    Comparison is constant-time, and repeated failures from one client are throttled."""

    WINDOW, MAX_FAILS = 60.0, 10

    def __init__(self, app: ASGIApp):
        self.app = app
        self.fails: dict[str, deque[float]] = defaultdict(deque)

    def _throttled(self, client: str) -> bool:
        q, now = self.fails[client], time.monotonic()
        while q and now - q[0] > self.WINDOW:
            q.popleft()
        return len(q) >= self.MAX_FAILS

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if config.API_KEY and scope["type"] in ("http", "websocket"):
            path = scope["path"]
            protected = path.startswith(("/api", "/ws", "/mcp")) and path != "/api/health"
            if protected and scope.get("method") != "OPTIONS":
                headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope["headers"]}
                supplied = headers.get("x-api-key") or headers.get("authorization", "").removeprefix("Bearer ").strip()
                if not supplied and scope["type"] == "websocket":
                    query = scope.get("query_string", b"").decode()
                    if "token=" in query:
                        supplied = query.split("token=", 1)[1].split("&", 1)[0]
                client = (scope.get("client") or ("?", 0))[0]
                if self._throttled(client):
                    if scope["type"] == "websocket":
                        await send({"type": "websocket.close", "code": 4429})
                    else:
                        await _json(send, 429, {"error": "Too many failed attempts. Try again in a minute."}, [(b"retry-after", b"60")])
                    return
                if not supplied or not safe_equals(supplied, config.API_KEY):
                    self.fails[client].append(time.monotonic())
                    log.warning("rejected request to %s: missing or invalid API key (client %s)", path, client)
                    if scope["type"] == "websocket":
                        await send({"type": "websocket.close", "code": 4401})
                    else:
                        await _json(send, 401, {"error": "Missing or invalid API key"})
                    return
        await self.app(scope, receive, send)


UI_CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
          "font-src data:; media-src blob: data:; connect-src 'self'; frame-src blob: data: about:; object-src blob:; "
          "base-uri 'none'; form-action 'none'; frame-ancestors 'self'")


class SecurityHeadersMiddleware:
    """nosniff + no-referrer everywhere; a strict CSP on the standalone workbench page."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        is_ui = scope["path"] in ("/ui", "/ui/")

        async def wrapped(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                names = {k.lower() for k, _ in headers}
                if b"x-content-type-options" not in names:
                    headers.append((b"x-content-type-options", b"nosniff"))
                if b"referrer-policy" not in names:
                    headers.append((b"referrer-policy", b"no-referrer"))
                if is_ui and b"content-security-policy" not in names:
                    headers.append((b"content-security-policy", UI_CSP.encode()))
                if scope["path"].startswith("/api") and b"cache-control" not in names:
                    headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, wrapped)
