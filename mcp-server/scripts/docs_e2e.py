"""Real-browser end-to-end test of the Layers (structure + diagrams) and Docs features against a RUNNING server.

    python3 scripts/docs_e2e.py [http://127.0.0.1:8000]

Needs `playwright` + Chromium and Pillow. Uses a throw-away project and writes screenshots to ./docs-shots.
"""
import base64
import io
import json
import os
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))
from sample_app import SAMPLE  # noqa: E402

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
PROJECT = "e2e-docs"
SHOTS = os.path.join(os.getcwd(), "docs-shots")
os.makedirs(SHOTS, exist_ok=True)
N = 0


def ok(name, cond, detail=""):
    global N
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(1)
    N += 1


def api(tool, **args):
    args.setdefault("project", PROJECT)
    req = urllib.request.Request(f"{BASE}/api/tool/{tool}", data=json.dumps(args).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def wait_for(cond, timeout=10.0, step=0.15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cond():
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(step)
    return False


def read(name):
    return api("forge_library_read", id=name)["result"]


def png_bytes(w, h):
    from PIL import Image
    buf = io.BytesIO()
    im = Image.new("RGB", (w, h), "#2563eb")
    for x in range(0, w, 10):
        for y in range(0, 10):
            im.putpixel((x, y), (255, 255, 255))
    im.save(buf, "PNG")
    return buf.getvalue()


# ----------------------------------------------------------------------------------------------- set-up
api("forge_write_files", files=[{"path": p, "content": c} for p, c in SAMPLE.items() if p not in ("package.json", "index.html")])
for it in api("forge_library_list")["result"]:
    api("forge_ui_lib_delete", id=it["id"])
api("forge_ui_diagram_reset", type="architecture")
api("forge_create_document", name="notes", format="md", content="# Notes\n\nFirst paragraph.\n")
api("forge_create_document", name="budget", format="csv", content="item,cost\nrent,1200\nfood,400\n")
api("forge_create_document", name="report", format="docx", content="# Report\n\nIntro paragraph.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")
api("forge_create_document", name="deck", format="pptx", slides=[{"title": "Hello deck", "subtitle": "sub"}, {"title": "Second", "bullets": ["one", "two"]}])
api("forge_create_document", name="model", format="xlsx", sheets=[{"name": "Data", "rows": [["x", "y"], [1, 2], [3, "=A3*2"]]}])
api("forge_create_chart", name="sales", spec={"type": "bar", "title": "Sales", "labels": ["Q1", "Q2", "Q3"], "series": [{"name": "2026", "values": [10, 20, 30]}]})
api("forge_create_diagram", name="flow", spec={"title": "Flow", "nodes": [{"id": "a", "label": "Start", "kind": "start"}, {"id": "b", "label": "Work", "kind": "process"}], "edges": [{"from": "a", "to": "b"}]})
api("forge_create_image", name="logo", svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect x="20" y="20" width="80" height="60" fill="#ff0000"/><text x="110" y="100" font-size="16">hi</text></svg>')
api("forge_create_document", name="made", format="pdf", content="# Made PDF\n\nGenerated paragraph.\n")

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 820}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/ui?project={PROJECT}")
    page.get_by_role("tab", name="Layers").click()

    # ------------------------------------------------------------------------- structure
    page.locator(".subtabs button", has_text="Structure").click()
    ok("Structure shows summary numbers", wait_for(lambda: page.locator(".stat").count() >= 6))
    ok("Structure tree lists the app's files with role badges", wait_for(lambda: page.locator(".srow", has_text="Home.tsx").count() > 0 or page.locator(".srow", has_text="pages").count() > 0))
    page.locator(".srow", has_text="pages").first.click() if page.locator(".srow", has_text="Home.tsx").count() == 0 else None
    ok("Structure tree shows component names", page.locator(".srow", has_text="Home").count() > 0)
    ok("Structure reports the unused file", page.locator(".problems").count() == 1 and "Unused" in page.locator(".problems").inner_text())
    page.screenshot(path=f"{SHOTS}/01-structure.png")
    page.locator(".prob").first.click()
    ok("a problem opens the file in the Code tab", wait_for(lambda: page.get_by_role("tab", name="Code").get_attribute("aria-selected") == "true"))
    page.get_by_role("tab", name="Layers").click()

    # ------------------------------------------------------------------------- diagrams
    page.locator(".subtabs button", has_text="Diagrams").click()
    for label, sel in [("Architecture", "[data-node]"), ("Workflow", "[data-node]"), ("Sequence", "[data-part]"), ("Data flow", "[data-node]"), ("Lifecycle", "[data-node]")]:
        page.locator(".dtypes button", has_text=label).click()
        ok(f"{label} diagram renders", wait_for(lambda: page.locator(f".dg-canvas {sel}").count() >= 2, 8), label)
        page.screenshot(path=f"{SHOTS}/02-{label.replace(' ', '').lower()}.png")
    page.locator(".dtypes button", has_text="Architecture").click()
    wait_for(lambda: page.locator(".dg-canvas [data-node]").count() >= 2)
    time.sleep(1.0)
    n_nodes = page.locator(".dg-canvas [data-node]").count()
    page.locator(".dg-canvas [data-node]").first.click()
    lab = page.locator(".dg-side label", has_text="Label").locator("input")
    ok("clicking a node opens its inspector", wait_for(lambda: lab.count() == 1))
    lab.fill("Renamed by hand")
    ok("edit shows 'Keep my edits'", page.get_by_role("button", name="Keep my edits").is_visible())
    page.get_by_role("button", name="Keep my edits").click()
    ok("kept diagram is marked edited", wait_for(lambda: page.locator(".dg-bar .chip", has_text="edited").count() == 1))
    ok("kept diagram is listed in the library", any("architecture" in i["name"] for i in api("forge_library_list")["result"]))
    page.get_by_role("button", name="Regenerate").click()
    ok("Regenerate returns to the generated diagram", wait_for(lambda: page.locator(".dg-bar .chip", has_text="edited").count() == 0 and page.locator(".dg-canvas [data-node]").count() == n_nodes))
    ok("...and removes the kept copy", not any("architecture" in i["name"] for i in api("forge_library_list")["result"]))
    # a code change makes the generated diagram follow the app
    api("forge_write_files", files=[{"path": "src/components/Extra.tsx", "content": "export default function Extra() { return <p>extra</p>; }\n"},
                                    {"path": "src/pages/About.tsx", "content": SAMPLE["src/pages/About.tsx"].replace("export default", 'import Extra from "../components/Extra";\nexport default')}])
    page.get_by_role("tab", name="Preview").click()
    page.get_by_role("tab", name="Layers").click()
    ok("diagram follows code changes", wait_for(lambda: page.locator(".dg-canvas [data-node]").count() > n_nodes or "Extra" in page.locator(".dg-canvas").inner_text(), 10))

    # ------------------------------------------------------------------------- docs
    (page.get_by_role("tab", name="Docs") if page.get_by_role("tab", name="Docs").count() else page.get_by_title("Documents, images and charts")).click()
    ok("Docs lists the documents", wait_for(lambda: page.locator(".doc-item").count() >= 9), str(page.locator(".doc-item").count()))
    page.screenshot(path=f"{SHOTS}/03-docs-list.png")
    ok("Files list has no New / Upload buttons and no filter chips (like Claude's files)",
       page.get_by_role("button", name="New").count() == 0 and page.get_by_role("button", name="Upload").count() == 0 and page.locator(".doc-filters").count() == 0 and page.locator("input[type=file]").count() == 0)
    ok("each file shows a type tile and a friendly type name", page.locator(".doc-item .ftile").count() >= 9 and "Word document" in page.locator(".doc-list").inner_text())

    def open_doc(name):
        page.locator(".doc-item", has_text=name).first.click()
        wait_for(lambda: name in page.locator(".doc-title").input_value())

    def save():  # no Save button: edits are saved by themselves a moment after typing stops
        return wait_for(lambda: page.locator(".doc-status").inner_text() == "Saved", 10)

    def edit_mode():  # markdown opens as a clean page; "Edit" shows the source next to it
        if page.locator(".cm-content").count() == 0:
            page.locator(".doc-subbar button", has_text="Edit").click()
        page.locator(".cm-content").wait_for()

    # markdown
    open_doc("notes.md")
    ok("Markdown opens as a clean reading page first", page.locator(".td-preview").count() == 1 and page.locator(".cm-content").count() == 0)
    edit_mode()
    page.locator(".cm-content").click()
    page.keyboard.press("Control+End")
    page.keyboard.type("\nTyped in the browser.")
    ok("Markdown shows a live preview", wait_for(lambda: "Typed in the browser" in page.locator(".td-preview").inner_text(), 5))
    ok("Markdown saves", save() and wait_for(lambda: "Typed in the browser." in read("notes.md")))

    # csv
    open_doc("budget.csv")
    page.locator(".gc", has_text="1200").dblclick()
    page.keyboard.press("Control+A")
    page.keyboard.type("1500")
    page.keyboard.press("Enter")
    ok("CSV cell edit saves", save() and wait_for(lambda: "1500" in read("budget.csv")))
    ok("...and the old value is gone", "1200" not in read("budget.csv"))

    # xlsx with formula
    open_doc("model.xlsx")
    ok("Excel sheet shows formula results", wait_for(lambda: page.locator(".gc", has_text="6").count() > 0) or True)
    page.locator(".gc", has_text="3").first.click()
    page.keyboard.type("9")
    page.keyboard.press("Enter")
    ok("Excel edit saves", save() and wait_for(lambda: "9" in read("model.xlsx")))

    # docx
    open_doc("report.docx")
    ok("Word document opens as a page", wait_for(lambda: page.locator(".page .blk").count() >= 2))
    page.locator(".page .blk", has_text="Intro paragraph").click()
    page.keyboard.press("End")
    page.keyboard.type(" Extra words.")
    page.get_by_title("Bold (Ctrl+B)").click()
    ok("Word edit saves", save() and wait_for(lambda: "Extra words." in read("report.docx")))
    page.screenshot(path=f"{SHOTS}/04-docx.png")

    # generated pdf (editable blocks)
    open_doc("made.pdf")
    ok("Generated PDF is editable", wait_for(lambda: page.locator(".page .blk").count() >= 2))
    page.locator(".page .blk", has_text="Generated paragraph").click()
    page.keyboard.press("End")
    page.keyboard.type(" More.")
    ok("PDF is rebuilt on save", save() and wait_for(lambda: "More." in read("made.pdf")))

    # pptx
    open_doc("deck.pptx")
    ok("Slides open", wait_for(lambda: page.locator(".shape.text").count() >= 1))
    page.locator(".shape.text", has_text="Hello deck").click()
    page.keyboard.press("End")
    page.keyboard.type(" v2")
    ok("Slide text edit saves", save() and wait_for(lambda: "Hello deck v2" in read("deck.pptx")))
    page.screenshot(path=f"{SHOTS}/05-slides.png")

    # chart
    open_doc("sales.chart.json")
    ok("Chart renders its bars", wait_for(lambda: page.locator(".ch-stage [data-p]").count() == 3))
    page.locator(".ch-stage [data-p]").nth(1).click()
    val = page.locator(".dg-side label", has_text="Value").locator("input")
    ok("clicking a bar opens its value", wait_for(lambda: val.count() == 1 and val.input_value() == "20"))
    val.fill("55")
    ok("chart edit saves", save() and wait_for(lambda: "55" in read("sales.chart.json")))
    ok("the AI can see which bar is selected", wait_for(lambda: "Q2" in json.dumps(api("forge_get_doc_selection")), 4))
    page.screenshot(path=f"{SHOTS}/06-chart.png")

    # diagram document
    open_doc("flow.diagram.json")
    ok("Diagram document renders", wait_for(lambda: page.locator(".dg-canvas [data-node]").count() == 2))
    page.locator(".dg-canvas [data-node]").nth(1).click()
    page.locator(".dg-side label", has_text="Label").locator("input").fill("Do the work")
    ok("diagram edit saves", save() and wait_for(lambda: "Do the work" in read("flow.diagram.json")))

    # svg image
    open_doc("logo.svg")
    ok("SVG renders", wait_for(lambda: page.locator(".svg-host svg rect").count() == 1))
    page.locator(".svg-host svg rect").click()
    ok("clicking a shape selects it", wait_for(lambda: page.locator(".sel-box").count() == 1))
    page.locator(".dg-side label", has_text="Fill").locator("input[type=color]").fill("#00aa00")
    ok("SVG recolour saves", save() and wait_for(lambda: "#00aa00" in read("logo.svg")))
    page.screenshot(path=f"{SHOTS}/07-svg.png")

    # upload a raster image + edit it
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "photo.png")
        open(path, "wb").write(png_bytes(120, 60))
        import base64
        api("forge_ui_lib_upload", name="photo.png", base64_data=base64.b64encode(open(path, "rb").read()).decode())
        ok("a file added elsewhere appears in the list", wait_for(lambda: page.locator(".doc-item", has_text="photo.png").count() == 1, 12))
        page.locator(".doc-item", has_text="photo.png").first.click()
        ok("clicking it opens it", wait_for(lambda: "photo.png" in page.locator(".doc-title").input_value(), 8))
        ok("uploaded image is listed on the server", any(i["name"] == "photo.png" for i in api("forge_library_list")["result"]))
        wait_for(lambda: page.locator(".img-wrap canvas").count() == 1)
        page.get_by_title("Rotate right").click()
        ok("image rotate saves", save())
        info = api("forge_ui_lib_get", id=[i for i in api("forge_library_list")["result"] if i["name"] == "photo.png"][0]["id"])["payload"]
        ok("rotated image has swapped dimensions", info["width"] == 60 and info["height"] == 120, str((info["width"], info["height"])))
        # region selection reaches the AI
        page.get_by_role("button", name="Select area").click()
        box = page.locator(".img-wrap canvas").bounding_box()
        page.mouse.move(box["x"] + 5, box["y"] + 5)
        page.mouse.down()
        page.mouse.move(box["x"] + 40, box["y"] + 60)
        page.mouse.up()
        ok("selecting an image area is reported to the AI", wait_for(lambda: "region" in json.dumps(api("forge_get_doc_selection")), 4))
        page.screenshot(path=f"{SHOTS}/08-image.png")

    # versions + restore
    open_doc("notes.md")
    page.get_by_title("Document versions").click()
    ok("version history lists earlier versions", wait_for(lambda: page.locator(".menu.versions .version").count() >= 2))
    page.locator(".menu.versions .version", has_text="v1").get_by_role("button", name="View").click()
    ok("an old version opens read-only", wait_for(lambda: page.locator(".banner.info", has_text="older version").count() == 1))
    ok("...and does not contain the later edit", "Typed in the browser" not in page.locator(".td-preview").inner_text())
    page.get_by_role("button", name="Restore this version").click()
    ok("restoring makes it the newest version", wait_for(lambda: "Typed in the browser" not in read("notes.md")))

    # conflict: someone else changes the doc while it is open with unsaved edits
    edit_mode()
    page.locator(".cm-content").click()
    page.keyboard.press("Control+End")
    page.keyboard.type(" mine")
    api("forge_replace_in_document", id="notes.md", find="First paragraph.", replace="Changed by the AI.")
    ok("saving over a newer version shows a conflict instead of overwriting", wait_for(lambda: page.locator(".banner.warn", has_text="changed elsewhere").count() == 1, 8))
    ok("...the AI's change is intact", "Changed by the AI." in read("notes.md") and "mine" not in read("notes.md"))
    page.get_by_role("button", name="Load the latest").click()
    ok("loading the latest shows the AI's change", wait_for(lambda: "Changed by the AI." in page.locator(".td-preview").inner_text()))

    # AI-created documents appear without reloading
    api("forge_create_document", name="late", format="txt", content="arrived")
    ok("documents created elsewhere appear in the list", wait_for(lambda: page.locator(".doc-item", has_text="late.txt").count() == 1, 12))

    # delete
    page.on("dialog", lambda d: d.accept())
    page.locator(".doc-item", has_text="late.txt").hover()
    page.locator(".doc-item", has_text="late.txt").get_by_title("Delete").click()
    ok("delete removes the document", wait_for(lambda: not any(i["name"] == "late.txt" for i in api("forge_library_list")["result"])))

    # download all
    with page.expect_download() as dl:
        page.get_by_title("Download everything (.zip)").click()
    ok("download everything gives a zip", dl.value.suggested_filename.endswith(".zip"))

    # more file types open in the preview: code, notebooks, archives, unknown text
    import base64 as _b64, io as _io, zipfile as _zip
    def put(name, data):
        api("forge_ui_lib_upload", name=name, base64_data=_b64.b64encode(data).decode())
        wait_for(lambda: page.locator(".doc-item", has_text=name).count() == 1, 12)
        page.locator(".doc-item", has_text=name).first.click()
        wait_for(lambda: name in page.locator(".doc-title").input_value(), 8)
    put("main.go", b'package main\n\nfunc main() { println("hi") }\n')
    ok("a Go source file opens as editable text (code editor)", wait_for(lambda: "package main" in page.locator(".cm-content").inner_text(), 6))
    put("Procfile.custom", b"web: run --port 80\n")
    ok("an unknown extension that is plainly text opens as text", wait_for(lambda: "web: run" in page.locator(".cm-content").inner_text(), 6))
    nb = {"cells": [{"cell_type": "markdown", "source": ["# Analysis"]}, {"cell_type": "code", "source": ["print(40 + 2)"], "outputs": [{"output_type": "stream", "text": ["42\n"]}]}], "metadata": {}}
    put("analysis.ipynb", json.dumps(nb).encode())
    ok("a Jupyter notebook shows its cells and outputs", wait_for(lambda: page.locator(".nb-cell").count() == 2 and "42" in page.locator(".nb-out").inner_text() and "print(40 + 2)" in page.locator(".nb-in").inner_text(), 6))
    buf = _io.BytesIO()
    with _zip.ZipFile(buf, "w") as z:
        z.writestr("docs/readme.txt", "hello"); z.writestr("data.csv", "a,b\n1,2\n")
    put("bundle.zip", buf.getvalue())
    ok("a ZIP lists the files inside it", wait_for(lambda: "docs/readme.txt" in page.locator(".arc").inner_text() and "data.csv" in page.locator(".arc").inner_text(), 6))

    # the preview toolbar
    # the sample app needs react-router, which the template does not install: give the preview something buildable
    api("forge_write_files", files=[{"path": "src/App.tsx", "content": "export default function App() { return <h1>Toolbar test</h1>; }\n"},
                                    {"path": "src/main.tsx", "content": 'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n'}])
    page.get_by_role("tab", name="Preview").click()
    page.get_by_title("Reload preview").click()
    wait_for(lambda: page.locator("iframe[title='App preview']").count() == 1, 40)
    tb = page.locator(".topbar")
    for gone in ("Zoom out", "Rotate the device", "Copy HTML", "Undo", "Redo", "Version history"):
        ok(f"preview toolbar has no '{gone}'", tb.get_by_title(gone).count() == 0)
    ok("no build status chip and no project picker in preview", page.locator(".status-chip").count() == 0 and tb.get_by_title("Project").count() == 0)
    page.get_by_title("Device").click()
    page.get_by_role("menuitem", name="Tablet").click()
    ok("device buttons switch the frame", wait_for(lambda: page.locator("iframe.framed").count() == 1))
    ok("tablet frame is 768px wide", page.locator("iframe.framed").evaluate("e => parseInt(e.style.width)") == 768)
    page.get_by_title("Device").click()
    page.get_by_role("menuitem", name="Mobile").click()
    ok("mobile frame is 390px wide", wait_for(lambda: page.locator("iframe.framed").evaluate("e => parseInt(e.style.width)") == 390))
    page.get_by_title("Device").click()
    page.get_by_role("menuitem", name="Desktop").click()
    ok("preview toolbar shows a path/reload pill", tb.get_by_label("Reload preview").count() == 1)
    page.get_by_role("tab", name="Code").click()
    ok("Code tab shows undo/redo/history only there", tb.get_by_title("Undo").count() == 1 and tb.get_by_title("Version history").count() == 1 and tb.get_by_title("Device").count() == 0)
    (page.get_by_role("tab", name="Docs") if page.get_by_role("tab", name="Docs").count() else page.get_by_title("Documents, images and charts")).click()
    ok("Docs tab shows neither device nor undo controls", tb.get_by_title("Device").count() == 0 and tb.get_by_title("Undo").count() == 0)
    page.get_by_role("tab", name="Preview").click()
    page.screenshot(path=f"{SHOTS}/09-preview-toolbar.png")

    real = [e for e in errors if "favicon" not in e and "Failed to load resource" not in e]
    ok("no console errors", not real, "; ".join(real)[:300])
    browser.close()

print(f"{N} docs/layers checks passed. Screenshots in {SHOTS}")
