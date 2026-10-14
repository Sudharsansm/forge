"""Static analysis of a Forge project (Vite + React + TypeScript).

Produces the facts that the Layers tab turns into a project-structure tree and five diagram types
(architecture, workflow, sequence, dataflow, lifecycle). Everything is derived from the source with
tree-sitter: imports, components, JSX usage, hooks, state, event handlers, links and network calls.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

import tree_sitter_typescript as tsts
from tree_sitter import Language, Node, Parser

_TSX = Parser(Language(tsts.language_tsx()))
_TS = Parser(Language(tsts.language_typescript()))

CODE_EXT = (".tsx", ".ts", ".jsx", ".js", ".mjs")
RESOLVE_EXT = (".tsx", ".ts", ".jsx", ".js", ".mjs", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp")
ASSET_EXT = (".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".mp4")
MAX_PARSE_BYTES = 400_000


# ------------------------------------------------------------------------------------------------ data model
@dataclass
class Handler:
    event: str
    handler: str  # function name or "inline"
    tag: str
    label: str
    line: int
    sets: list[str] = field(default_factory=list)       # state variables it updates
    navigates: list[str] = field(default_factory=list)  # routes it navigates to
    fetches: list[str] = field(default_factory=list)    # network calls it makes


@dataclass
class StateVar:
    name: str
    setter: str
    hook: str
    init: str
    line: int


@dataclass
class Effect:
    deps: str  # "[]", "[a, b]", "every render"
    cleanup: bool
    line: int
    fetches: list[str] = field(default_factory=list)


@dataclass
class Component:
    name: str
    line: int
    renders: list[str] = field(default_factory=list)          # components it renders (in order, unique)
    props_to: dict[str, list[str]] = field(default_factory=dict)  # child component -> prop names passed
    hooks: list[str] = field(default_factory=list)
    state: list[StateVar] = field(default_factory=list)
    effects: list[Effect] = field(default_factory=list)
    handlers: list[Handler] = field(default_factory=list)
    contexts: list[str] = field(default_factory=list)         # useContext(X)
    links: list[tuple[str, str]] = field(default_factory=list)  # (route, label)
    fetches: list[str] = field(default_factory=list)
    storage: bool = False
    props_in: list[str] = field(default_factory=list)


@dataclass
class Import:
    spec: str
    names: list[str]
    resolved: str | None  # project path of a relative/aliased import
    external: bool
    line: int


@dataclass
class FileInfo:
    path: str
    size: int
    lines: int
    role: str = "other"
    imports: list[Import] = field(default_factory=list)
    exports: list[str] = field(default_factory=list)
    components: list[Component] = field(default_factory=list)
    module_renders: list[str] = field(default_factory=list)  # JSX used outside components (e.g. main.tsx)
    contexts_created: list[str] = field(default_factory=list)
    routes: list[tuple[str, str | None]] = field(default_factory=list)  # (path, component name)
    parse_error: bool = False


@dataclass
class Analysis:
    project: str
    files: dict[str, FileInfo]
    package: dict
    routes: list[dict]
    imported_by: dict[str, list[str]]
    problems: list[dict]
    comp_file: dict[str, str]  # component name -> file path


# ------------------------------------------------------------------------------------------------ tree helpers
def _txt(n: Node | None) -> str:
    return n.text.decode("utf-8", "replace") if n is not None and n.text is not None else ""


def _walk(node: Node):
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(reversed(n.children))


def _unquote(s: str) -> str:
    return s[1:-1] if len(s) >= 2 and s[0] in "'\"`" and s[-1] == s[0] else s


def _line(n: Node) -> int:
    return n.start_point[0] + 1


def _has_jsx(n: Node) -> bool:
    return any(c.type in ("jsx_element", "jsx_self_closing_element", "jsx_fragment") for c in _walk(n))


def _tag_name(opening: Node) -> str:
    name = opening.child_by_field_name("name")
    return _txt(name)


def _element_label(el: Node) -> str:
    """Readable label of a JSX element: its text, aria-label, title or placeholder."""
    opening = el if el.type == "jsx_self_closing_element" else (el.children[0] if el.children else el)
    for a in opening.children:
        if a.type == "jsx_attribute" and a.children and _txt(a.children[0]) in ("aria-label", "title", "placeholder", "alt", "value", "name"):
            v = a.children[-1] if len(a.children) >= 3 else None
            if v is not None and v.type == "string":
                return _unquote(_txt(v))[:40]
    if el.type == "jsx_element":
        parts = []
        for c in _walk(el):
            if c.type == "jsx_text" and _txt(c).strip():
                parts.append(" ".join(_txt(c).split()))
            if len(" ".join(parts)) > 40:
                break
        return " ".join(parts)[:40]
    return ""


# ------------------------------------------------------------------------------------------------ per-file parsing
STATE_HOOKS = {"useState", "useReducer"}
FETCH_CALLEES = {"fetch", "axios", "$fetch", "useSWR", "useQuery"}


def _string_arg(call: Node) -> str:
    args = call.child_by_field_name("arguments")
    if args is None:
        return ""
    for c in args.children:
        if c.type in ("string", "template_string"):
            return _unquote(_txt(c))
        if c.type not in ("(", ")", ","):
            return "dynamic URL" if c.type != "string" else ""
    return ""


def _callee(call: Node) -> str:
    f = call.child_by_field_name("function")
    return _txt(f)


def _function_index(root: Node) -> dict[str, Node]:
    """name -> function/arrow node for every named function in the file (any nesting)."""
    out: dict[str, Node] = {}
    for n in _walk(root):
        if n.type == "function_declaration":
            nm = n.child_by_field_name("name")
            if nm is not None:
                out.setdefault(_txt(nm), n)
        elif n.type == "variable_declarator":
            val = n.child_by_field_name("value")
            nm = n.child_by_field_name("name")
            if val is not None and nm is not None and nm.type == "identifier" and val.type in ("arrow_function", "function_expression", "function"):
                out.setdefault(_txt(nm), val)
    return out


def _scan_effects(fn: Node, states: dict[str, str]) -> tuple[list[str], list[str], list[str]]:
    """(state vars set, routes navigated to, network calls) inside a function body."""
    sets, navs, fetches = [], [], []
    for c in _walk(fn):
        if c.type != "call_expression":
            continue
        name = _callee(c)
        if name in states and states[name] not in sets:
            sets.append(states[name])
        elif name in ("navigate", "router.push", "history.push", "nav"):
            t = _string_arg(c)
            if t and t not in navs:
                navs.append(t)
        elif name.split(".")[0] in FETCH_CALLEES or name in FETCH_CALLEES:
            t = _string_arg(c) or "network request"
            if t not in fetches:
                fetches.append(t)
    return sets, navs, fetches


def _analyse_component(name: str, node: Node, funcs: dict[str, Node], known: set[str], file_props: list[str]) -> Component:
    comp = Component(name=name, line=_line(node), props_in=file_props)
    states: dict[str, str] = {}  # setter name -> state var name
    # pass 1: hooks and state
    for n in _walk(node):
        if n.type == "variable_declarator":
            val = n.child_by_field_name("value")
            pat = n.child_by_field_name("name")
            if val is not None and val.type == "call_expression" and pat is not None and pat.type == "array_pattern":
                hook = _callee(val)
                if hook in STATE_HOOKS:
                    ids = [_txt(c) for c in pat.children if c.type == "identifier"]
                    if len(ids) == 2:
                        args = val.child_by_field_name("arguments")
                        init = " ".join(_txt(args).strip("()").split())[:24] if args is not None else ""
                        comp.state.append(StateVar(ids[0], ids[1], hook, init, _line(n)))
                        states[ids[1]] = ids[0]
        if n.type == "call_expression":
            callee = _callee(n)
            if re.fullmatch(r"use[A-Z]\w*", callee) and callee not in comp.hooks:
                comp.hooks.append(callee)
            if callee == "useContext":
                args = n.child_by_field_name("arguments")
                ctx = _txt(args.children[1]) if args is not None and len(args.children) > 1 else ""
                if ctx and ctx not in comp.contexts:
                    comp.contexts.append(ctx)
            if callee in ("useEffect", "useLayoutEffect"):
                args = n.child_by_field_name("arguments")
                parts = [c for c in (args.children if args is not None else []) if c.type not in ("(", ")", ",")]
                deps = "every render"
                if len(parts) > 1 and parts[1].type == "array":
                    deps = " ".join(_txt(parts[1]).split())
                body = parts[0] if parts else None
                cleanup = False
                fetches: list[str] = []
                if body is not None:
                    blk = body.child_by_field_name("body")
                    if blk is not None and blk.type == "statement_block":
                        cleanup = any(r.type == "return_statement" and any(c.type in ("arrow_function", "function_expression") for c in r.children)
                                      for r in blk.children)
                    fetches = _scan_effects(body, states)[2]
                comp.effects.append(Effect(deps, cleanup, _line(n), fetches))
            if callee.split(".")[0] in FETCH_CALLEES or callee in FETCH_CALLEES:
                t = _string_arg(n) or "network request"
                if t not in comp.fetches:
                    comp.fetches.append(t)
            if callee.startswith(("localStorage.", "sessionStorage.")):
                comp.storage = True
            if callee in ("navigate",):
                pass
    # pass 2: JSX
    for n in _walk(node):
        if n.type not in ("jsx_element", "jsx_self_closing_element"):
            continue
        opening = n if n.type == "jsx_self_closing_element" else n.children[0]
        tag = _tag_name(opening)
        attrs = [a for a in opening.children if a.type == "jsx_attribute"]
        attr_names = [_txt(a.children[0]) for a in attrs if a.children]
        if tag in known and tag != name:
            if tag not in comp.renders:
                comp.renders.append(tag)
            props = [a for a in attr_names if not re.fullmatch(r"on[A-Z]\w*|key|ref|className|children", a)]
            if props:
                comp.props_to[tag] = sorted(set(comp.props_to.get(tag, []) + props))
        if tag in ("Link", "NavLink"):
            for a in attrs:
                if a.children and _txt(a.children[0]) == "to" and len(a.children) >= 3 and a.children[-1].type == "string":
                    comp.links.append((_unquote(_txt(a.children[-1])), _element_label(n) or "link"))
        if tag == "a":
            for a in attrs:
                if a.children and _txt(a.children[0]) == "href" and len(a.children) >= 3 and a.children[-1].type == "string":
                    href = _unquote(_txt(a.children[-1]))
                    if href.startswith(("#/", "/")) and not href.startswith("//"):
                        comp.links.append((href.lstrip("#"), _element_label(n) or "link"))
        for a in attrs:
            if not a.children:
                continue
            ev = _txt(a.children[0])
            if not re.fullmatch(r"on[A-Z]\w*", ev):
                continue
            val = a.children[-1] if len(a.children) >= 3 else None
            handler, fn = "inline", None
            if val is not None and val.type == "jsx_expression":
                inner = [c for c in val.children if c.type not in ("{", "}")]
                if inner and inner[0].type == "identifier":
                    handler = _txt(inner[0])
                    fn = funcs.get(handler)
                elif inner and inner[0].type in ("arrow_function", "function_expression"):
                    fn = inner[0]
                    body = inner[0].child_by_field_name("body")
                    if body is not None and body.type == "call_expression" and _callee(body) in funcs:
                        handler = _callee(body)
                        fn = funcs.get(handler, fn)
            sets, navs, fets = _scan_effects(fn, states) if fn is not None else ([], [], [])
            comp.handlers.append(Handler(ev, handler, tag, _element_label(n), _line(a), sets, navs, fets))
    return comp


def _component_nodes(root: Node) -> list[tuple[str, Node]]:
    """Top-level (possibly exported) functions that start with a capital letter and render JSX."""
    out: list[tuple[str, Node]] = []

    def consider(name: str, fn: Node) -> None:
        if name and name[0].isupper() and _has_jsx(fn):
            out.append((name, fn))

    for top in root.children:
        node = top.child_by_field_name("declaration") if top.type == "export_statement" else top
        if node is None:
            # export default function () {}  /  export default () => ...
            continue
        if node.type == "function_declaration":
            consider(_txt(node.child_by_field_name("name")), node)
        elif node.type in ("lexical_declaration", "variable_declaration"):
            for d in node.children:
                if d.type != "variable_declarator":
                    continue
                nm, val = d.child_by_field_name("name"), d.child_by_field_name("value")
                if nm is None or val is None or nm.type != "identifier":
                    continue
                if val.type in ("arrow_function", "function_expression", "function"):
                    consider(_txt(nm), val)
                elif val.type == "call_expression":  # memo(...), forwardRef(...)
                    inner = next((c for c in _walk(val) if c.type in ("arrow_function", "function_expression")), None)
                    if inner is not None:
                        consider(_txt(nm), inner)
        elif node.type == "class_declaration":
            consider(_txt(node.child_by_field_name("name")), node)
    return out


def _prop_names(fn: Node) -> list[str]:
    params = fn.child_by_field_name("parameters")
    if params is None:
        p = fn.child_by_field_name("parameter")
        params = p
    if params is None:
        return []
    names: list[str] = []
    for c in _walk(params):
        if c.type in ("shorthand_property_identifier_pattern", "shorthand_property_identifier"):
            names.append(_txt(c))
        elif c.type == "pair_pattern":
            k = c.child_by_field_name("key")
            if k is not None:
                names.append(_txt(k))
        elif c.type == "property_signature":
            k = c.child_by_field_name("name")
            if k is not None:
                names.append(_txt(k))
    out: list[str] = []
    for n in names:
        if n not in out:
            out.append(n)
    return out[:10]


def _resolve(spec: str, importer: str, files: set[str]) -> str | None:
    if spec.startswith("."):
        base = PurePosixPath(importer).parent.joinpath(spec)
    elif spec.startswith(("@/", "~/")):
        base = PurePosixPath("src") / spec[2:]
    else:
        return None
    parts: list[str] = []
    for part in base.parts:
        if part == "..":
            if parts:
                parts.pop()
        elif part != ".":
            parts.append(part)
    cand = "/".join(parts)
    if cand in files:
        return cand
    for ext in RESOLVE_EXT:
        if cand + ext in files:
            return cand + ext
    for ext in RESOLVE_EXT:
        if f"{cand}/index{ext}" in files:
            return f"{cand}/index{ext}"
    return None


def parse_file(path: str, text: str, all_files: set[str], known_components: set[str]) -> FileInfo:
    info = FileInfo(path=path, size=len(text.encode("utf-8")), lines=text.count("\n") + (1 if text and not text.endswith("\n") else 0))
    if not path.endswith(CODE_EXT) or info.size > MAX_PARSE_BYTES:
        return info
    parser = _TSX if path.endswith((".tsx", ".jsx", ".js", ".mjs")) else _TS
    try:
        tree = parser.parse(text.encode("utf-8"))
    except Exception:  # noqa: BLE001 - never let one file break the analysis
        info.parse_error = True
        return info
    root = tree.root_node
    info.parse_error = root.has_error
    # imports / exports
    for n in root.children:
        if n.type == "import_statement":
            src = n.child_by_field_name("source")
            spec = _unquote(_txt(src))
            names: list[str] = []
            for c in _walk(n):
                if c.type == "identifier" and c.parent is not None and c.parent.type == "import_clause":
                    names.append(_txt(c))
                elif c.type == "import_specifier":
                    nm = c.child_by_field_name("alias") or c.child_by_field_name("name")
                    names.append(_txt(nm))
                elif c.type == "namespace_import":
                    names.append("* " + _txt(c.children[-1]))
            resolved = _resolve(spec, path, all_files)
            info.imports.append(Import(spec, names, resolved, resolved is None and not spec.startswith("."), _line(n)))
        elif n.type == "export_statement":
            decl = n.child_by_field_name("declaration")
            if decl is not None:
                nm = decl.child_by_field_name("name")
                if nm is not None:
                    info.exports.append(_txt(nm))
                else:
                    for d in decl.children:
                        if d.type == "variable_declarator":
                            info.exports.append(_txt(d.child_by_field_name("name")))
            elif any(c.type == "default" for c in n.children):
                val = n.child_by_field_name("value")
                info.exports.append(_txt(val) if val is not None and val.type == "identifier" else "default")
    funcs = _function_index(root)
    for name, fn in _component_nodes(root):
        info.components.append(_analyse_component(name, fn, funcs, known_components, _prop_names(fn)))
    # JSX outside components (main.tsx: createRoot(...).render(<App />))
    if not info.components and _has_jsx(root):
        for n in _walk(root):
            if n.type in ("jsx_element", "jsx_self_closing_element"):
                opening = n if n.type == "jsx_self_closing_element" else n.children[0]
                tag = _tag_name(opening)
                if tag in known_components and tag not in info.module_renders:
                    info.module_renders.append(tag)
    # context creation + routes
    for n in _walk(root):
        if n.type == "variable_declarator":
            val = n.child_by_field_name("value")
            if val is not None and val.type == "call_expression" and _callee(val) in ("createContext", "React.createContext"):
                info.contexts_created.append(_txt(n.child_by_field_name("name")))
    info.routes = _find_routes(root, text)
    return info


_ROUTE_ELEMENT = re.compile(r"""<Route\b[^>]*?\bpath\s*=\s*["']([^"']+)["'][^>]*?\belement\s*=\s*\{\s*<\s*([A-Z]\w*)""", re.S)
_ROUTE_COMPONENT = re.compile(r"""<Route\b[^>]*?\bpath\s*=\s*["']([^"']+)["'][^>]*?\bcomponent\s*=\s*\{\s*([A-Z]\w*)""", re.S)
_ROUTE_OBJ = re.compile(r"""\bpath\s*:\s*["']([^"']+)["']\s*,\s*element\s*:\s*<\s*([A-Z]\w*)""", re.S)
_ROUTE_PATH_ONLY = re.compile(r"""<Route\b[^>]*?\bpath\s*=\s*["']([^"']+)["']""")


def _find_routes(root: Node, text: str) -> list[tuple[str, str | None]]:
    found: dict[str, str | None] = {}
    for rx in (_ROUTE_ELEMENT, _ROUTE_COMPONENT, _ROUTE_OBJ):
        for m in rx.finditer(text):
            found.setdefault(m.group(1), m.group(2))
    for m in _ROUTE_PATH_ONLY.finditer(text):
        found.setdefault(m.group(1), None)
    return list(found.items())


# ------------------------------------------------------------------------------------------------ roles
def _role(info: FileInfo, entry: str | None, root_app: str | None, route_components: set[str]) -> str:
    p = info.path
    low = p.lower()
    name = PurePosixPath(p).name
    if p == entry:
        return "entry"
    if p == root_app:
        return "root"
    if low.endswith(".css"):
        return "style"
    if low.endswith(ASSET_EXT):
        return "asset"
    if name in ("package.json", "package-lock.json") or re.match(r"(vite|tsconfig|tailwind|postcss|eslint|forge)[\w.-]*\.(ts|js|json|mjs|cjs)$", name) or name.startswith("tsconfig"):
        return "config"
    if low.endswith((".md", ".txt")):
        return "doc"
    if low.endswith("index.html"):
        return "html"
    if not low.endswith(CODE_EXT):
        return "other"
    comp_names = {c.name for c in info.components}
    if comp_names & route_components or re.search(r"/(pages|routes|views|screens)/", "/" + low):
        return "page"
    if info.components:
        return "component"
    if info.contexts_created or re.search(r"/(store|stores|context|contexts|state)/", "/" + low) or re.search(r"(store|context|provider)\.", name.lower()):
        return "store"
    if re.match(r"use[A-Z]", name) or re.search(r"/hooks?/", "/" + low) or any(e.startswith("use") and e[3:4].isupper() for e in info.exports):
        return "hook"
    if re.search(r"/(data|mock|mocks|fixtures|content|constants)/", "/" + low) or re.search(r"(data|mock|fixtures|constants|content)\.(ts|js)x?$", name.lower()):
        return "data"
    if re.search(r"/(types?|models?)/", "/" + low) or re.match(r"types?\.(ts|d\.ts)$", name):
        return "types"
    if re.search(r"/(utils?|lib|helpers?|services?|api)/", "/" + low):
        return "util"
    return "module"


# ------------------------------------------------------------------------------------------------ whole project
def _find_entry(files: dict[str, str]) -> str | None:
    for cand in ("src/main.tsx", "src/main.jsx", "src/main.ts", "src/index.tsx", "src/index.jsx", "src/main.js", "src/index.js"):
        if cand in files:
            return cand
    html = files.get("index.html", "")
    m = re.search(r"""<script[^>]*src=["']/?([^"']+)["']""", html)
    if m and m.group(1) in files:
        return m.group(1)
    return None


def _find_cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    """Strongly connected components with more than one file (Tarjan, iterative)."""
    index, low, on, stack, out = {}, {}, set(), [], []
    counter = [0]
    for start in graph:
        if start in index:
            continue
        work = [(start, iter(graph.get(start, ())))]
        index[start] = low[start] = counter[0]; counter[0] += 1
        stack.append(start); on.add(start)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in graph:
                    continue
                if w not in index:
                    index[w] = low[w] = counter[0]; counter[0] += 1
                    stack.append(w); on.add(w)
                    work.append((w, iter(graph.get(w, ()))))
                    advanced = True
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop(); on.discard(w); comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    out.append(sorted(comp))
    return out


def analyze(project: str, sources: dict[str, str], routes: list[dict] | None = None, sizes: dict[str, int] | None = None) -> Analysis:
    """`sources` maps project-relative path -> text for every readable file; `sizes` overrides byte sizes (assets are not read)."""
    all_files = set(sources)
    # pass 1: find component names so JSX usage can be matched against them
    quick: dict[str, FileInfo] = {}
    known: set[str] = set()
    for path, text in sources.items():
        if path.endswith(CODE_EXT):
            fi = parse_file(path, text, all_files, set())
            quick[path] = fi
            known.update(c.name for c in fi.components)
    files: dict[str, FileInfo] = {}
    for path, text in sources.items():
        files[path] = parse_file(path, text, all_files, known) if path.endswith(CODE_EXT) else FileInfo(
            path=path, size=len(text.encode("utf-8")), lines=text.count("\n") + 1)
    for p, n in (sizes or {}).items():
        if p in files:
            files[p].size = n
    comp_file: dict[str, str] = {}
    for p, fi in files.items():
        for c in fi.components:
            comp_file.setdefault(c.name, p)
    entry = _find_entry(sources)
    app_candidates = [p for p in ("src/App.tsx", "src/App.jsx", "src/App.ts", "src/App.js") if p in files]
    root_app = app_candidates[0] if app_candidates else None
    route_components = {c for fi in files.values() for _, c in fi.routes if c}
    for fi in files.values():
        fi.role = _role(fi, entry, root_app, route_components)
    # packages
    try:
        package = json.loads(sources.get("package.json", "{}"))
    except json.JSONDecodeError:
        package = {}
    # reverse import graph + problems
    imported_by: dict[str, list[str]] = {}
    graph: dict[str, set[str]] = {}
    problems: list[dict] = []
    for p, fi in files.items():
        graph.setdefault(p, set())
        for imp in fi.imports:
            if imp.resolved:
                imported_by.setdefault(imp.resolved, []).append(p)
                graph[p].add(imp.resolved)
            elif imp.spec.startswith((".", "@/", "~/")):
                problems.append({"kind": "unresolved-import", "severity": "error", "path": p, "line": imp.line,
                                 "message": f"Cannot resolve import '{imp.spec}'"})
        if fi.parse_error and p.endswith(CODE_EXT):
            problems.append({"kind": "syntax", "severity": "error", "path": p, "line": 1, "message": "The file has syntax errors"})
    deps = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    for p, fi in files.items():
        for imp in fi.imports:
            if imp.external:
                pkg = "/".join(imp.spec.split("/")[:2]) if imp.spec.startswith("@") else imp.spec.split("/")[0]
                if package and pkg not in deps and not pkg.startswith(("node:", "virtual:")) and pkg not in ("react", "react-dom"):
                    problems.append({"kind": "missing-dependency", "severity": "warning", "path": p, "line": imp.line,
                                     "message": f"'{pkg}' is imported but not listed in package.json"})
    for p, fi in files.items():
        if fi.role in ("component", "page", "hook", "util", "data", "store", "module", "types") and p not in imported_by and p != entry:
            problems.append({"kind": "unused-file", "severity": "info", "path": p, "line": 1, "message": "Nothing imports this file"})
    for cyc in _find_cycles(graph):
        problems.append({"kind": "circular-import", "severity": "warning", "path": cyc[0], "line": 1,
                         "message": "Circular imports: " + " ↔ ".join(cyc[:5])})
    # routes: combine the source-level detector with component links
    route_list: list[dict] = []
    seen: set[str] = set()
    for fi in files.values():
        for rp, comp in fi.routes:
            r = rp if rp.startswith("/") else "/" + rp
            if r not in seen:
                seen.add(r)
                route_list.append({"path": r, "component": comp, "file": comp_file.get(comp or "")})
    for r in routes or []:
        if r["path"] not in seen:
            seen.add(r["path"])
            route_list.append({"path": r["path"], "component": None, "file": None, "label": r.get("label")})
    if "/" not in seen:
        top = next((c for c in (files[root_app].components if root_app else [])), None)
        route_list.insert(0, {"path": "/", "component": top.name if top else None, "file": root_app})
    return Analysis(project, files, package, route_list, imported_by, problems, comp_file)


# ------------------------------------------------------------------------------------------------ structure tree
ROLE_LABEL = {"entry": "Entry point", "root": "App root", "page": "Page", "component": "Component", "hook": "Hook", "store": "State / context",
              "data": "Data", "util": "Utility", "types": "Types", "module": "Module", "style": "Stylesheet", "asset": "Asset",
              "config": "Config", "doc": "Document", "html": "HTML shell", "other": "File"}


def structure(a: Analysis, keep=None) -> dict:
    """`keep(path)` limits the tree and the totals to the files the user should see (the starter plumbing is left out)."""
    keep = keep or (lambda _p: True)
    shown = {p: fi for p, fi in a.files.items() if keep(p)}
    root: dict = {"name": a.project, "path": "", "type": "dir", "children": []}
    nodes: dict[str, dict] = {"": root}
    for path in sorted(shown):
        parts = path.split("/")
        for i in range(len(parts) - 1):
            d = "/".join(parts[: i + 1])
            if d not in nodes:
                node = {"name": parts[i], "path": d, "type": "dir", "children": []}
                nodes["/".join(parts[:i]) if i else ""]["children"].append(node)
                nodes[d] = node
        fi = shown[path]
        parent = nodes["/".join(parts[:-1]) if len(parts) > 1 else ""]
        parent["children"].append({
            "name": parts[-1], "path": path, "type": "file", "role": fi.role, "roleLabel": ROLE_LABEL.get(fi.role, "File"),
            "size": fi.size, "lines": fi.lines,
            "components": [c.name for c in fi.components], "exports": fi.exports[:8],
            "imports": len([i for i in fi.imports if i.resolved]), "importedBy": len(a.imported_by.get(path, [])),
            "external": sorted({i.spec for i in fi.imports if i.external})[:8],
            "unused": fi.role in ("component", "page", "hook", "util", "data", "store", "module", "types") and path not in a.imported_by and fi.role != "entry",
        })

    def finish(node: dict) -> tuple[int, int, int]:
        if node["type"] == "file":
            return 1, node["lines"], node["size"]
        node["children"].sort(key=lambda c: (c["type"] != "dir", c["name"].lower()))
        f = l = s = 0
        for c in node["children"]:
            cf, cl, cs = finish(c)
            f, l, s = f + cf, l + cl, s + cs
        node["files"], node["lines"], node["size"] = f, l, s
        return f, l, s

    total_files, total_lines, total_size = finish(root)
    roles: dict[str, int] = {}
    for fi in shown.values():
        roles[fi.role] = roles.get(fi.role, 0) + 1
    comps = sum(len(fi.components) for fi in shown.values())
    return {
        "project": a.project, "tree": root,
        "summary": {
            "files": total_files, "lines": total_lines, "bytes": total_size, "components": comps, "roles": roles,
            "routes": a.routes, "dependencies": a.package.get("dependencies", {}), "devDependencies": a.package.get("devDependencies", {}),
            "stateVars": sum(len(c.state) for fi in shown.values() for c in fi.components),
            "handlers": sum(len(c.handlers) for fi in shown.values() for c in fi.components),
            "effects": sum(len(c.effects) for fi in shown.values() for c in fi.components),
        },
        "problems": a.problems[:200],
    }


def source_files(files: dict[str, str], max_bytes: int = 400_000) -> tuple[dict[str, str], dict[str, int]]:
    """The project's text files (from memory) and their sizes; very large files are listed but not read."""
    out: dict[str, str] = {}
    sizes: dict[str, int] = {}
    for rel in sorted(files):
        text = files[rel]
        sizes[rel] = len(text.encode("utf-8"))
        out[rel] = "" if sizes[rel] > max_bytes or rel.lower().endswith(ASSET_EXT) else text
    return out, sizes
