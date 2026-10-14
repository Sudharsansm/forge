"""Turn an `Analysis` into diagram specs: architecture, workflow, sequence, dataflow, lifecycle.

A spec is plain JSON, shared with the window and the documents library, so every generated diagram can be
edited by hand (rename, recolour, add or remove nodes and edges) and saved.

    graph spec:    {version, kind:"graph", type, title, direction, groups:[{id,label}],
                    nodes:[{id,label,sub?,kind,group?,file?,line?}], edges:[{id,from,to,label?,dashed?}]}
    sequence spec: {version, kind:"sequence", type:"sequence", title,
                    participants:[{id,label,kind,file?}], messages:[{id,from,to,label,kind:"call"|"return"|"self"|"note",phase?}]}
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import deque
from pathlib import PurePosixPath

from .analyzer import Analysis, Component, ROLE_LABEL

TYPES = ("architecture", "workflow", "sequence", "dataflow", "lifecycle")
TITLES = {"architecture": "Architecture", "workflow": "Workflow", "sequence": "Sequence", "dataflow": "Data flow", "lifecycle": "Lifecycle"}
MAX_NODES = 45


class _Graph:
    def __init__(self, type_: str, title: str, direction: str = "LR", groups: list[tuple[str, str]] | None = None):
        self.type, self.title, self.direction = type_, title, direction
        self.groups = [{"id": g, "label": l} for g, l in (groups or [])]
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple[str, str, str], dict] = {}

    def node(self, id_: str, label: str, kind: str, group: str | None = None, sub: str | None = None,
             file: str | None = None, line: int | None = None) -> str:
        if id_ not in self.nodes:
            n: dict = {"id": id_, "label": label, "kind": kind}
            if group:
                n["group"] = group
            if sub:
                n["sub"] = sub
            if file:
                n["file"] = file
            if line:
                n["line"] = line
            self.nodes[id_] = n
        return id_

    def edge(self, a: str, b: str, label: str = "", dashed: bool = False) -> None:
        if a == b or a not in self.nodes or b not in self.nodes:
            return
        key = (a, b, label)
        if key not in self.edges:
            e: dict = {"id": f"e{len(self.edges) + 1}", "from": a, "to": b}
            if label:
                e["label"] = label
            if dashed:
                e["dashed"] = True
            self.edges[key] = e

    def spec(self) -> dict:
        used = {g for g in (n.get("group") for n in self.nodes.values()) if g}
        return {"version": 1, "kind": "graph", "type": self.type, "title": self.title, "direction": self.direction,
                "groups": [g for g in self.groups if g["id"] in used], "nodes": list(self.nodes.values()), "edges": list(self.edges.values())}


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_./:-]+", "-", s).strip("-")


def _short(path: str) -> str:
    return PurePosixPath(path).name


def _all_components(a: Analysis) -> list[tuple[str, Component]]:
    return [(p, c) for p, fi in a.files.items() for c in fi.components]


def _root_component(a: Analysis) -> tuple[str, Component] | None:
    for p, c in _all_components(a):
        if a.files[p].role == "root":
            return p, c
    for fi in a.files.values():
        if fi.role == "entry" and fi.module_renders:
            name = fi.module_renders[0]
            if name in a.comp_file:
                path = a.comp_file[name]
                return path, next(c for c in a.files[path].components if c.name == name)
    comps = _all_components(a)
    return comps[0] if comps else None


def _lookup(a: Analysis, name: str) -> tuple[str, Component] | None:
    path = a.comp_file.get(name)
    if not path:
        return None
    return path, next(c for c in a.files[path].components if c.name == name)


def _tree_from(a: Analysis, start: str, limit: int = 60) -> list[str]:
    """Component names reachable from `start` by rendering, breadth first."""
    seen, order, q = {start}, [start], deque([start])
    while q and len(order) < limit:
        cur = q.popleft()
        found = _lookup(a, cur)
        if not found:
            continue
        for child in found[1].renders:
            if child not in seen:
                seen.add(child); order.append(child); q.append(child)
    return order


# --------------------------------------------------------------------------------------------- architecture
_LAYERS = [("entry", "Entry"), ("app", "App and pages"), ("ui", "Components"), ("logic", "State and hooks"),
           ("data", "Data and utilities"), ("assets", "Styles and assets"), ("pkg", "Packages")]
_ROLE_LAYER = {"entry": "entry", "html": "entry", "root": "app", "page": "app", "component": "ui", "store": "logic", "hook": "logic",
               "data": "data", "util": "data", "module": "data", "types": "data", "style": "assets", "asset": "assets"}


def architecture(a: Analysis) -> dict:
    g = _Graph("architecture", "Architecture · " + a.project, "LR", _LAYERS)
    files = {p: fi for p, fi in a.files.items() if fi.role in _ROLE_LAYER and fi.role != "types"}
    # Too many files: fold the crowded roles into one node per folder until the diagram stays readable.
    folded: dict[str, str] = {}  # file path -> folder node id

    def node_count() -> int:
        return len(files) - len(folded) + len(set(folded.values()))

    for role in ("component", "module", "util", "data", "hook", "asset"):
        if node_count() <= MAX_NODES:
            break
        by_dir: dict[str, list[str]] = {}
        for p, fi in files.items():
            if fi.role == role and p not in folded:
                by_dir.setdefault(str(PurePosixPath(p).parent), []).append(p)
        for d, members in by_dir.items():
            if len(members) >= 2:
                for m in members:
                    folded[m] = f"dir:{role}:{d}"

    def node_of(path: str) -> str | None:
        return folded.get(path) or (f"f:{path}" if path in files else None)

    for p, fi in files.items():
        if p in folded:
            continue
        comps = ", ".join(c.name for c in fi.components[:3])
        g.node(f"f:{p}", _short(p), fi.role, _ROLE_LAYER[fi.role], comps or ROLE_LABEL.get(fi.role, ""), file=p)
    for nid in sorted(set(folded.values())):
        _, role, d = nid.split(":", 2)
        members = [p for p, v in folded.items() if v == nid]
        g.node(nid, f"{d}/", role, _ROLE_LAYER[role], f"{len(members)} {ROLE_LABEL[role].lower()} files", file=sorted(members)[0])
    pkg_uses: dict[str, list[str]] = {}
    for p, fi in a.files.items():
        for imp in fi.imports:
            if imp.external:
                pkg = "/".join(imp.spec.split("/")[:2]) if imp.spec.startswith("@") else imp.spec.split("/")[0]
                pkg_uses.setdefault(pkg, []).append(p)
    for pkg, users in sorted(pkg_uses.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:8]:
        g.node(f"pkg:{pkg}", pkg, "package", "pkg", f"{len(users)} import{'s' if len(users) != 1 else ''}")
        for u in sorted(set(users), key=lambda u: (a.files[u].role not in ("entry", "root"), u))[:3]:
            if node_of(u):
                g.edge(node_of(u), f"pkg:{pkg}", dashed=True)
    for p, fi in a.files.items():
        src = node_of(p)
        if not src:
            continue
        for imp in fi.imports:
            if imp.resolved and node_of(imp.resolved):
                g.edge(src, node_of(imp.resolved))
    return g.spec()


# --------------------------------------------------------------------------------------------------- workflow
def _page_owner(a: Analysis) -> dict[str, str]:
    """component name -> route path of the page that renders it (first page wins)."""
    owner: dict[str, str] = {}
    root = _root_component(a)
    for r in a.routes:
        comp = r.get("component") or (root[1].name if root and r["path"] == "/" else None)
        if not comp:
            continue
        for name in _tree_from(a, comp):
            owner.setdefault(name, r["path"])
    return owner


def _route_node_id(path: str) -> str:
    return f"page:{path}"


def workflow(a: Analysis) -> dict:
    g = _Graph("workflow", "Workflow · " + a.project, "LR")
    g.node("start", "Open the app", "start")
    owner = _page_owner(a)
    routes = a.routes or [{"path": "/", "component": None}]
    for r in routes[:10]:
        comp = r.get("component")
        label = r.get("label") or ("Homepage" if r["path"] == "/" else r["path"].strip("/").split("/")[-1].replace("-", " ").title())
        g.node(_route_node_id(r["path"]), label, "page", sub=f"{r['path']}" + (f" · <{comp}/>" if comp else ""), file=r.get("file"))
    first = _route_node_id(routes[0]["path"] if routes[0]["path"] == "/" else "/") if _route_node_id("/") in g.nodes else _route_node_id(routes[0]["path"])
    g.edge("start", first, "load")

    per_page: dict[str, int] = {}
    nodes_budget = 40
    for path, comp in _all_components(a):
        page = owner.get(comp.name) or ("/" if _route_node_id("/") in g.nodes else None)
        if not page or _route_node_id(page) not in g.nodes:
            continue
        pid = _route_node_id(page)
        for link, text in comp.links:
            target = link if link.startswith("/") else "/" + link
            if _route_node_id(target) in g.nodes:
                g.edge(pid, _route_node_id(target), f"link “{text}”" if text and text != "link" else "link")
        for h in comp.handlers:
            if len(g.nodes) >= nodes_budget or per_page.get(page, 0) >= 8:
                break
            if h.event in ("onMouseEnter", "onMouseLeave", "onFocus", "onBlur", "onKeyDown", "onKeyUp") and not (h.sets or h.navigates or h.fetches):
                continue
            verb = {"onClick": "Click", "onSubmit": "Submit", "onChange": "Change", "onInput": "Type in", "onKeyDown": "Press key in"}.get(h.event, h.event[2:])
            what = f"“{h.label}”" if h.label else f"<{h.tag}>"
            aid = f"act:{path}:{h.line}"
            g.node(aid, f"{verb} {what}", "action", sub=f"{h.event} → {h.handler}", file=path, line=h.line)
            g.edge(pid, aid, "user")
            per_page[page] = per_page.get(page, 0) + 1
            for s in h.sets:
                rid = g.node(f"set:{comp.name}.{s}", f"Update “{s}”", "process", sub=f"state in {comp.name}", file=path)
                g.edge(aid, rid)
                g.edge(rid, pid, "re-render", dashed=True)
            for url in h.fetches:
                rid = g.node(f"net:{url}", f"Request {url}", "service")
                g.edge(aid, rid)
            for nav in h.navigates:
                t = nav if nav.startswith("/") else "/" + nav
                if _route_node_id(t) in g.nodes:
                    g.edge(aid, _route_node_id(t), "navigate")
        for e in comp.effects:
            for url in e.fetches:
                if len(g.nodes) >= nodes_budget:
                    break
                rid = g.node(f"net:{url}", f"Request {url}", "service")
                g.edge(pid, rid, "on load")
    # fall back for an app without interactions: show the render chain
    if len(g.nodes) <= 1 + len(routes):
        root = _root_component(a)
        if root:
            prev = first
            for name in _tree_from(a, root[1].name, 8)[:8]:
                nid = g.node(f"render:{name}", f"Render <{name}/>", "component", file=a.comp_file.get(name))
                g.edge(prev, nid)
                prev = nid
    return g.spec()


# ------------------------------------------------------------------------------------------------- sequence
def sequence(a: Analysis) -> dict:
    parts: list[dict] = []
    msgs: list[dict] = []

    def P(id_: str, label: str, kind: str, file: str | None = None) -> str:
        if not any(p["id"] == id_ for p in parts):
            d = {"id": id_, "label": label, "kind": kind}
            if file:
                d["file"] = file
            parts.append(d)
        return id_

    def M(frm: str, to: str, label: str, kind: str = "call", phase: str | None = None) -> None:
        d = {"id": f"m{len(msgs) + 1}", "from": frm, "to": to, "label": label, "kind": kind}
        if phase:
            d["phase"] = phase
        msgs.append(d)

    root = _root_component(a)
    entry = next((p for p, fi in a.files.items() if fi.role == "entry"), None)
    P("user", "User", "user")
    P("browser", "Browser", "html")
    if entry:
        P("main", _short(entry), "entry", entry)
    app_id = None
    if root:
        app_id = P(f"c:{root[1].name}", f"<{root[1].name}/>", "root", root[0])
    M("user", "browser", "Open the app")
    if entry:
        M("browser", "main", "load script")
        if app_id:
            M("main", app_id, "createRoot().render()")
    elif app_id:
        M("browser", app_id, "mount")
    tree = _tree_from(a, root[1].name, 12) if root else []
    shown: list[str] = []
    if root:
        M(app_id, app_id, "Mount: render tree", "note", "Mount")
        for name in tree[1:7]:
            found = _lookup(a, name)
            if not found:
                continue
            parent = next((n for n in tree if _lookup(a, n) and name in _lookup(a, n)[1].renders), root[1].name)
            pid = f"c:{parent}"
            P(f"c:{name}", f"<{name}/>", "component", found[0])
            if any(p["id"] == pid for p in parts):
                M(pid, f"c:{name}", f"render <{name}/>")
                shown.append(name)
    comps_in_view = [root[1].name] + shown if root else []
    has_state = has_net = has_store = False
    for name in comps_in_view:
        found = _lookup(a, name)
        if not found:
            continue
        c = found[1]
        cid = f"c:{name}"
        for e in c.effects[:2]:
            M(cid, cid, f"useEffect {e.deps}", "self")
            for url in e.fetches[:2]:
                P("net", "Network", "service")
                M(cid, "net", f"fetch {url}")
                M("net", cid, "response", "return")
                has_net = True
        if c.state:
            has_state = True
    if root and (a.files.get(root[0]) is not None):
        M(app_id, "browser", "commit DOM", "return")
    acts = 0
    first_interaction = True
    for name in comps_in_view:
        found = _lookup(a, name)
        if not found:
            continue
        c = found[1]
        cid = f"c:{name}"
        for h in c.handlers:
            if acts >= 6 or not (h.sets or h.navigates or h.fetches or h.event == "onClick"):
                continue
            if first_interaction:
                M("user", "user", "Interaction", "note", "Interaction")
                first_interaction = False
            M("user", cid, f"{h.event[2:].lower()} {('“' + h.label + '”') if h.label else '<' + h.tag + '>'}")
            if h.handler != "inline":
                M(cid, cid, f"{h.handler}()", "self")
            for s in h.sets[:2]:
                P("state", "React state", "state")
                M(cid, "state", f"set {s}")
                M("state", cid, "re-render", "return")
                has_state = True
            for url in h.fetches[:1]:
                P("net", "Network", "service")
                M(cid, "net", f"fetch {url}")
                M("net", cid, "response", "return")
            for nav in h.navigates[:1]:
                if app_id and cid != app_id:
                    M(cid, app_id, f"navigate {nav}")
            acts += 1
    if has_state and not any(p["id"] == "state" for p in parts):
        P("state", "React state", "state")
    for sid in ("state", "net"):
        pass
    title = "Sequence · " + a.project
    return {"version": 1, "kind": "sequence", "type": "sequence", "title": title, "participants": parts, "messages": msgs}


# ------------------------------------------------------------------------------------------------- dataflow
def dataflow(a: Analysis) -> dict:
    g = _Graph("dataflow", "Data flow · " + a.project, "LR",
               [("src", "Sources"), ("store", "State"), ("ui", "Components"), ("out", "Output")])
    g.node("evt:user", "User events", "user", "src")
    g.node("out:dom", "Rendered UI", "output", "out", "DOM")
    root = _root_component(a)
    comps = _all_components(a)
    involved: set[str] = set()
    if root:
        involved.add(root[1].name)
    for p, c in comps:
        if c.state or c.fetches or c.contexts or c.props_to or c.handlers or c.storage or c.effects:
            involved.add(c.name)
        for ch in c.props_to:
            involved.add(ch)
    for name in list(involved):
        f = _lookup(a, name)
        if f:
            for imp in a.files[f[0]].imports:
                if imp.resolved and a.files.get(imp.resolved) and a.files[imp.resolved].role in ("data", "store", "util", "module", "hook"):
                    involved.add(name)
    for p, c in comps:
        if c.name not in involved or len(g.nodes) > 60:
            continue
        kind = "root" if root and c.name == root[1].name else "component"
        cid = g.node(f"c:{c.name}", f"<{c.name}/>", kind, "ui", file=p, line=c.line,
                     sub=("props: " + ", ".join(c.props_in[:4])) if c.props_in else None)
        fi = a.files[p]
        for imp in fi.imports:
            if imp.resolved and a.files.get(imp.resolved):
                target = a.files[imp.resolved]
                if target.role in ("data", "store", "util", "module", "hook", "types") and target.role != "types":
                    nid = g.node(f"f:{imp.resolved}", _short(imp.resolved), target.role if target.role != "module" else "data",
                                 "store" if target.role in ("store", "hook") else "src", ", ".join(target.exports[:3]) or None,
                                 file=imp.resolved)
                    g.edge(nid, cid, ", ".join(imp.names[:3]))
        for s in c.state[:4]:
            sid = g.node(f"state:{c.name}.{s.name}", s.name, "state", "store", f"{s.hook}({s.init})" if s.init else s.hook, file=p, line=s.line)
            g.edge(cid, sid, "owns")
            g.edge(sid, cid, "read", dashed=True)
        for ctx in c.contexts:
            xid = g.node(f"ctx:{ctx}", ctx, "store", "store", "context")
            g.edge(xid, cid, "useContext")
        for url in c.fetches[:3]:
            nid = g.node(f"net:{url}", url if len(url) < 28 else url[:25] + "…", "service", "src", "network")
            g.edge(nid, cid, "response", dashed=True)
        if c.storage:
            nid = g.node("storage", "Browser storage", "service", "src", "localStorage")
            g.edge(nid, cid, "read/write", dashed=True)
        events = sorted({h.event for h in c.handlers})
        if events:
            g.edge("evt:user", cid, ", ".join(events[:3]))
        for child, props in c.props_to.items():
            if f"c:{child}" in g.nodes or child in involved:
                chid = g.node(f"c:{child}", f"<{child}/>", "component", "ui", file=a.comp_file.get(child))
                g.edge(cid, chid, "props: " + ", ".join(props[:4]))
        if not c.renders or not any(ch in involved for ch in c.renders):
            g.edge(cid, "out:dom", "paint")
    for ctxfile, fi in a.files.items():
        for ctx in fi.contexts_created:
            if f"ctx:{ctx}" in g.nodes:
                g.nodes[f"ctx:{ctx}"]["file"] = ctxfile
    return g.spec()


# ------------------------------------------------------------------------------------------------ lifecycle
_STAGES = [("boot", "1 · Boot"), ("render", "2 · Render"), ("mount", "3 · Mount"), ("interact", "4 · Interact"),
           ("update", "5 · Update"), ("teardown", "6 · Teardown")]


def lifecycle(a: Analysis) -> dict:
    g = _Graph("lifecycle", "Lifecycle · " + a.project, "LR", _STAGES)
    root = _root_component(a)
    entry = next((p for p, fi in a.files.items() if fi.role == "entry"), None)
    g.node("html", "index.html", "html", "boot", "browser loads the shell", file="index.html" if "index.html" in a.files else None)
    prev = "html"
    if entry:
        g.node("main", _short(entry), "entry", "boot", "createRoot().render()", file=entry)
        g.edge("html", "main", "script")
        prev = "main"
    comp_names = _tree_from(a, root[1].name, 10) if root else []
    for name in comp_names:
        f = _lookup(a, name)
        if not f:
            continue
        c = f[1]
        sub = ", ".join(c.hooks[:3]) if c.hooks else "no hooks"
        g.node(f"r:{name}", f"<{name}/>", "root" if root and name == root[1].name else "component", "render", sub, file=f[0], line=c.line)
    if comp_names:
        g.edge(prev, f"r:{comp_names[0]}", "render")
    for name in comp_names:
        f = _lookup(a, name)
        if not f:
            continue
        for ch in f[1].renders:
            g.edge(f"r:{name}", f"r:{ch}", "child")
    g.node("commit", "Commit to DOM", "process", "mount", "paint + refs attached")
    for name in comp_names[:1]:
        g.edge(f"r:{name}", "commit", "commit")
    for name in comp_names:
        f = _lookup(a, name)
        if not f:
            continue
        c = f[1]
        for i, e in enumerate(c.effects[:2]):
            when = "once, after first render" if e.deps == "[]" else "after every render" if e.deps == "every render" else f"when {e.deps.strip('[]')} change"
            eid = g.node(f"fx:{name}:{i}", f"{name}: useEffect", "effect", "mount", when, file=f[0], line=e.line)
            g.edge("commit", eid, "effects run")
            g.edge(f"r:{name}", eid, dashed=True)
            if e.cleanup:
                cid = g.node(f"cl:{name}:{i}", f"{name}: cleanup", "effect", "teardown", "returned function runs", file=f[0], line=e.line)
                g.edge(eid, cid, "on unmount / re-run", dashed=True)
    g.node("ready", "UI ready", "process", "interact", "waiting for input")
    g.edge("commit", "ready")
    count = 0
    for p, c in _all_components(a):
        if c.name not in comp_names:
            continue
        for h in c.handlers:
            if count >= 8 or not (h.sets or h.navigates or h.fetches or h.event == "onClick"):
                continue
            hid = g.node(f"h:{p}:{h.line}", f"{h.event}" + (f" “{h.label}”" if h.label else f" <{h.tag}>"), "action", "interact",
                         f"{h.handler}()", file=p, line=h.line)
            g.edge("ready", hid, "user")
            count += 1
            for s in h.sets:
                uid = g.node(f"u:{c.name}.{s}", f"set {s}", "state", "update", f"state in {c.name}", file=p)
                g.edge(hid, uid)
                g.edge(uid, f"r:{c.name}", "re-render", dashed=True)
            for url in h.fetches:
                nid = g.node(f"net:{url}", f"fetch {url}", "service", "update")
                g.edge(hid, nid)
    g.node("unmount", "root.unmount()", "process", "teardown", "tab closed / replaced")
    g.edge("ready", "unmount", dashed=True)
    for nid, n in list(g.nodes.items()):
        if nid.startswith("cl:"):
            g.edge("unmount", nid, dashed=True)
    return g.spec()


BUILDERS = {"architecture": architecture, "workflow": workflow, "sequence": sequence, "dataflow": dataflow, "lifecycle": lifecycle}


def build(a: Analysis, type_: str) -> dict:
    if type_ not in BUILDERS:
        raise ValueError(f"Unknown diagram type '{type_}'. Use one of: {', '.join(TYPES)}")
    spec = BUILDERS[type_](a)
    spec["generated"] = spec_hash(spec)
    return spec


def spec_hash(spec: dict) -> str:
    body = {k: v for k, v in spec.items() if k != "generated"}
    return hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:12]
