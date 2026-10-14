import json

from forge_core import analyzer, diagrams

from sample_app import SAMPLE


def analysis():
    return analyzer.analyze("demo", SAMPLE)


def test_components_state_effects_handlers():
    a = analysis()
    home = next(c for c in a.files["src/pages/Home.tsx"].components if c.name == "Home")
    assert [s.name for s in home.state] == ["count"]
    assert home.state[0].setter == "setCount" and home.state[0].init == "0"
    assert home.effects and home.effects[0].deps == "[]" and home.effects[0].cleanup is True
    assert home.effects[0].fetches == ["/api/items"]
    assert home.renders == ["Card"] and home.props_to["Card"] == ["items", "title"]
    h = home.handlers[0]
    assert (h.event, h.handler, h.label, h.sets) == ("onClick", "inc", "Add one", ["count"])
    about = a.files["src/pages/About.tsx"].components[0]
    assert about.handlers[0].navigates == ["/"]


def test_roles_routes_and_links():
    a = analysis()
    roles = {p: fi.role for p, fi in a.files.items()}
    assert roles["src/main.tsx"] == "entry" and roles["src/App.tsx"] == "root"
    assert roles["src/pages/Home.tsx"] == "page" and roles["src/components/Card.tsx"] == "component"
    assert roles["src/data/items.ts"] == "data" and roles["src/index.css"] == "style"
    assert roles["src/context/theme.tsx"] in ("component", "store")
    assert {r["path"]: r["component"] for r in a.routes} == {"/": "Home", "/about": "About"}
    app = a.files["src/App.tsx"].components[0]
    assert ("/about", "About us") in app.links
    assert a.files["src/main.tsx"].module_renders == ["App"]


def test_problems():
    kinds = {(p["kind"], p["path"]) for p in analysis().problems}
    assert ("unresolved-import", "src/utils/b.ts") in kinds
    assert ("missing-dependency", "src/utils/b.ts") in kinds
    assert ("unused-file", "src/components/Unused.tsx") in kinds
    assert any(k == "circular-import" for k, _ in kinds)


def test_structure_tree():
    st = analyzer.structure(analysis())
    assert st["summary"]["components"] >= 6 and st["summary"]["routes"]
    src = next(c for c in st["tree"]["children"] if c["name"] == "src")
    assert src["type"] == "dir" and src["files"] >= 8
    home = next(c for c in next(x for x in src["children"] if x["name"] == "pages")["children"] if c["name"] == "Home.tsx")
    assert home["role"] == "page" and home["importedBy"] == 1 and home["components"] == ["Home"]


def test_every_diagram_type_builds_and_is_consistent():
    a = analysis()
    for t in diagrams.TYPES:
        spec = diagrams.build(a, t)
        json.dumps(spec)
        assert spec["type"] == t and spec["generated"]
        if spec["kind"] == "graph":
            ids = {n["id"] for n in spec["nodes"]}
            assert len(ids) == len(spec["nodes"]) and spec["nodes"]
            assert all(e["from"] in ids and e["to"] in ids for e in spec["edges"])
            assert all(n.get("group") in {g["id"] for g in spec["groups"]} for n in spec["nodes"] if n.get("group"))
        else:
            pids = {p["id"] for p in spec["participants"]}
            assert all(m["from"] in pids and m["to"] in pids for m in spec["messages"])


def test_diagram_contents():
    a = analysis()
    arch = diagrams.build(a, "architecture")
    labels = {n["label"] for n in arch["nodes"]}
    assert {"main.tsx", "App.tsx", "Home.tsx", "Card.tsx", "react-router-dom"} <= labels
    assert any(e["from"] == "f:src/App.tsx" and e["to"] == "f:src/pages/Home.tsx" for e in arch["edges"])
    flow = diagrams.build(a, "workflow")
    flabels = " | ".join(n["label"] for n in flow["nodes"])
    assert "Click “Add one”" in flabels and "Update “count”" in flabels and "Request /api/items" in flabels
    assert any(e.get("label", "").startswith("link") for e in flow["edges"])
    seq = diagrams.build(a, "sequence")
    msgs = [m["label"] for m in seq["messages"]]
    assert "createRoot().render()" in msgs and any("fetch /api/items" in m for m in msgs) and any(m.startswith("set count") for m in msgs)
    data = diagrams.build(a, "dataflow")
    kinds = {n["kind"] for n in data["nodes"]}
    assert {"state", "data", "component", "service", "output"} <= kinds
    assert any(e["label"].startswith("props:") for e in data["edges"] if "label" in e)
    life = diagrams.build(a, "lifecycle")
    stages = {n.get("group") for n in life["nodes"]}
    assert {"boot", "render", "mount", "interact", "update", "teardown"} <= stages
    assert any(n["label"] == "Home: cleanup" for n in life["nodes"])


def test_large_projects_are_folded():
    src = dict(SAMPLE)
    for i in range(70):
        src[f"src/components/C{i}.tsx"] = f"export default function C{i}() {{ return <i>{i}</i>; }}\n"
        src["src/App.tsx"] = f'import C{i} from "./components/C{i}";\n' + src["src/App.tsx"]
    spec = diagrams.build(analyzer.analyze("big", src), "architecture")
    assert len(spec["nodes"]) <= diagrams.MAX_NODES + 12
    assert any(n["id"].startswith("dir:component") for n in spec["nodes"])
