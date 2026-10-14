"""Find the pages (routes) of a project so the workbench can offer a 'Homepage v' page selector."""
from __future__ import annotations

import re

ROUTE_RES = [
    re.compile(r"""<Route\b[^>]*\bpath\s*=\s*["']([^"']+)["']"""),
    re.compile(r"""\bpath\s*:\s*["']([^"']+)["']"""),
]


VALID = re.compile(r"^/?[A-Za-z0-9_\-]+(?:/[A-Za-z0-9_\-]+)*/?$|^/$")


def detect_routes(sources: dict[str, str]) -> list[dict]:
    found: dict[str, str] = {"/": "Homepage"}
    for path, text in sources.items():
        if not path.startswith("src/") or not path.endswith((".tsx", ".jsx", ".ts", ".js")):
            continue
        for rx in ROUTE_RES:
            for m in rx.finditer(text):
                route = m.group(1)
                if not VALID.match(route):
                    continue
                route = route if route.startswith("/") else "/" + route
                label = "Homepage" if route == "/" else route.strip("/").split("/")[-1].replace("-", " ").title()
                found.setdefault(route, label)
    return [{"path": p, "label": l} for p, l in found.items()]
