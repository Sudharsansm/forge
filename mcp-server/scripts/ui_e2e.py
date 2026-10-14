"""Real-browser end-to-end test of the Forge workbench (standalone mode) against a RUNNING server.

    python3 scripts/ui_e2e.py [http://127.0.0.1:8000]

Needs `playwright` + a Chromium. Creates a throw-away project, clicks through the UI, writes screenshots to ./ui-shots.
"""
import json
import os
import sys
import time
import urllib.request
import zipfile

from playwright.sync_api import expect, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
PROJECT = "e2e-ui"
SHOTS = os.path.join(os.getcwd(), "ui-shots")
os.makedirs(SHOTS, exist_ok=True)
N = 0


def ok(name, cond, detail=""):
    global N
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(1)
    N += 1


def api(tool, **args):
    req = urllib.request.Request(f"{BASE}/api/tool/{tool}", data=json.dumps(args).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def wait_for(cond, timeout=15.0, step=0.15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cond():
                return True
        except Exception:  # noqa: BLE001 - element not there yet
            pass
        time.sleep(step)
    return False


APP = '''export default function App() {
  return (
    <main className="min-h-screen bg-slate-50 p-10">
      <h1 className="text-4xl font-bold text-slate-900">Hello Forge</h1>
      <p className="mt-2 text-slate-600">A tiny page for testing.</p>
      <button className="mt-6 rounded bg-blue-600 px-4 py-2 text-white">Get started</button>
    </main>
  );
}
'''
api("forge_write_files", project=PROJECT, files=[{"path": "src/App.tsx", "content": APP}])
disk = lambda: api("forge_ui_read", project=PROJECT, path="src/App.tsx")["content"]  # noqa: E731
rest_hist = lambda: api("forge_ui_history", project=PROJECT, action="list")["entries"]  # noqa: E731

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1180, "height": 760}, accept_downloads=True)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{BASE}/ui?project={PROJECT}")
    frame = page.frame_locator("iframe[title='App preview']")
    cur = lambda: page.evaluate("navigator.clipboard.readText()")  # noqa: E731
    try:
        # ------------------------------------------------------------------ A. preview
        expect(frame.locator("h1")).to_have_text("Hello Forge", timeout=90_000)
        ok("preview builds and renders in the sandboxed iframe", True)
        ok("elements are tagged for selection", frame.locator("[data-forge-src]").count() >= 3)
        preview_bar_y = page.locator(".center-tools").bounding_box()["y"]
        ok("Preview tab has the page controls and no search box", page.get_by_label("Search", exact=True).count() == 0 and page.locator(".pathbar select").count() == 1 and page.get_by_title("Device").count() == 1)
        ok("Expand icon is visible", page.get_by_title("Expand").is_visible())

        # ------------------------------------------------------------------ B. Code tab: default file, search, manual edit
        page.get_by_role("tab", name="Code").click()
        expect(page.locator(".cm-content")).to_contain_text("Hello Forge", timeout=10_000)
        ok("Code tab shows code straight away (a default file is opened)", True)
        search = page.get_by_label("Search", exact=True)
        ok("search bar appears in the top bar, in the same place as the Preview page controls",
           search.is_visible() and abs(page.locator(".center-tools").bounding_box()["y"] - preview_bar_y) <= 2)
        search.fill("hello")
        expect(page.locator(".res-line").first).to_be_visible()
        ok("Code search finds text inside files (line number + highlighted match)",
           page.locator(".res-line").count() >= 1 and page.locator(".res-line mark").count() >= 1 and "in code" in page.locator(".results").inner_text().lower())
        page.screenshot(path=f"{SHOTS}/20-code-search.png")
        search.fill("app")
        ok("Code search also lists matching file names (fuzzy)", any("App.tsx" in t for t in page.locator(".res-file").all_inner_texts()))
        search.fill("hello")
        page.locator(".res-line").first.click()
        ok("clicking a result opens that file at that line", page.locator(".path").first.inner_text().startswith("src/App.tsx"))
        search.press("Escape")
        ok("Esc clears the search", search.input_value() == "" and page.locator(".results").count() == 0)
        ok("Code tab shows the folder tree", page.locator(".tree .row.file").count() >= 1)
        page.locator(".cm-content").click()
        page.keyboard.press("Control+a")
        page.keyboard.insert_text(APP.replace("Hello Forge", "Edited by hand"))
        ok("editor reports unsaved changes", "•" in page.locator(".path").first.inner_text())
        page.keyboard.press("Control+s")
        ok("Ctrl+S saves to disk", wait_for(lambda: "Edited by hand" in disk(), 5))
        page.get_by_role("tab", name="Preview").click()
        expect(frame.locator("h1")).to_have_text("Edited by hand", timeout=60_000)
        ok("manual edit shows up in the live preview", True)

        # ------------------------------------------------------------------ C. Files tab: cards + VS Code style path search + downloads
        page.get_by_role("tab", name="Files (download)").click()
        expect(page.get_by_role("button", name="Download all (.zip)")).to_be_visible()
        ok("Files tab shows downloadable file cards with type badge, folder, type and size",
           page.locator(".fcard").count() >= 5 and page.locator(".fbadge").first.is_visible() and
           "TSX" in page.locator(".fbadge").all_inner_texts() and page.locator(".fsub").first.inner_text().count("·") >= 2)
        ok("files are grouped by folder", page.locator(".fgroup-head b").count() >= 3 and "src" in " ".join(page.locator(".fgroup-head b").all_inner_texts()))
        page.screenshot(path=f"{SHOTS}/21-files-cards.png")
        fsearch = page.get_by_label("Search", exact=True)
        fsearch.fill("srcapp")
        ok("path search is fuzzy like VS Code: 'srcapp' finds src/App.tsx, with matches highlighted",
           any("App.tsx" in t for t in page.locator(".fname").all_inner_texts()) and page.locator(".fcard mark").count() >= 1)
        fsearch.fill("app.tsx")
        ok("best match comes first ('app.tsx' -> App.tsx)", page.locator(".fname").first.inner_text() == "App.tsx" and page.locator(".fcard").count() == 1)
        ok("search shows how many files match", "1 of" in page.locator(".search-summary").inner_text(), page.locator(".search-summary").inner_text())
        page.screenshot(path=f"{SHOTS}/22-files-search.png")
        fsearch.fill("zzzzq")
        ok("no match gives a clear message", page.locator(".fcard").count() == 0 and "No files match" in page.locator(".dl-scroll").inner_text())
        fsearch.fill("")
        with page.expect_download(timeout=20_000) as one:
            page.get_by_title("Download src/App.tsx").click()
        ok("single-file download gives that exact file", one.value.suggested_filename == "App.tsx" and "Edited by hand" in open(one.value.path(), encoding="utf-8").read())
        with page.expect_download(timeout=20_000) as fold:
            page.get_by_title("Download folder src (.zip)").click()
        names = zipfile.ZipFile(fold.value.path()).namelist()
        ok("folder download gives a zip of that folder", fold.value.suggested_filename == "src.zip" and "src/App.tsx" in names, str(names[:4]))
        with page.expect_download(timeout=20_000) as allz:
            page.get_by_role("button", name="Download all (.zip)").click()
        ok("download all gives the whole project", allz.value.suggested_filename == f"{PROJECT}.zip")
        page.locator(".fmain", has_text="App.tsx").first.click()
        expect(page.get_by_role("tab", name="Code")).to_have_attribute("aria-selected", "true")
        ok("clicking a file card opens it in the Code tab", True)

        # ------------------------------------------------------------------ D. Layers tab: structure and diagrams only
        page.get_by_role("tab", name="Layers").click()
        ok("Layers has Structure and Diagrams, and no Elements list", page.get_by_role("tab", name="Structure").count() == 1 and page.get_by_role("tab", name="Diagrams").count() == 1
           and page.get_by_role("tab", name="Elements").count() == 0 and page.locator(".layer").count() == 0)
        page.get_by_role("tab", name="Preview").click()

        # ------------------------------------------------------------------ E. Select tool: select only, no edit bar
        page.get_by_title("Select an element (V)").click()
        frame.locator("h1").click()
        ok("selecting an element shows no edit bar (select is only select)", wait_for(lambda: page.locator(".composer").is_visible(), 5) and page.locator(".ebar[role=toolbar]").count() == 0)
        comp = page.locator(".composer")
        ok("selecting an element shows it as a chip in the Lovable-style prompt box", comp.count() == 1 and "<h1>" in comp.locator(".cchip").inner_text())
        comp.get_by_placeholder("Ask Claude to change this element").fill("make this heading shout")
        comp.get_by_role("button", name="Copy prompt").click()
        ok("Ask AI builds a prompt that names the exact file, line and element",
           wait_for(lambda: "make this heading shout" in cur() and "src/App.tsx" in cur() and "<h1>" in cur(), 3))
        comp.get_by_placeholder("Ask Claude to change this element").click()
        page.keyboard.press("Escape")
        ok("Escape clears the selection even while typing in the prompt box", wait_for(lambda: page.locator(".composer").count() == 0, 3))

        # ------------------------------------------------------------------ F. Text tool edits in place
        page.get_by_title("Edit text (T)").click()
        frame.locator("p").click()
        ok("Text tool: clicking text starts editing in place", wait_for(lambda: frame.locator("p").get_attribute("contenteditable") is not None, 5)
           and wait_for(lambda: page.locator(".ebar.hint").is_visible(), 3) and "Enter to save" in page.locator(".ebar.hint").inner_text())
        page.screenshot(path=f"{SHOTS}/25-text-in-place.png")
        page.keyboard.insert_text("Paragraph typed in place")
        page.keyboard.press("Escape")
        ok("Esc cancels: the original text is restored and nothing is written",
           wait_for(lambda: frame.locator("p").inner_text() == "A tiny page for testing.", 3) and "Paragraph typed in place" not in disk())
        frame.locator("p").click()
        wait_for(lambda: frame.locator("p").get_attribute("contenteditable") is not None, 5)
        page.keyboard.insert_text("Paragraph typed in place")
        page.keyboard.press("Enter")
        ok("Text tool: Enter saves the paragraph", wait_for(lambda: "Paragraph typed in place" in disk(), 8))
        frame.locator("main").click(position={"x": 5, "y": 400})
        ok("clicking an element with no text of its own says so", wait_for(lambda: "no text of its own" in page.locator(".toast").inner_text(), 5))
        page.get_by_title("Edit text (T)").click()  # tool off

        # ------------------------------------------------------------------ F2. Draw annotation (pencil)
        page.get_by_title("Draw annotation (D)").click()
        ok("Draw is the third tool, between Text and Comment",
           [t.get_attribute("title") for t in page.locator(".toolbar .tool").all()[:4]] == ["Select an element (V)", "Edit text (T)", "Draw annotation (D)", "Comment on an element (C)"])
        hb = frame.locator("h1").bounding_box()
        page.mouse.move(hb["x"] - 10, hb["y"] + hb["height"] / 2); page.mouse.down()
        for k in range(1, 9):
            page.mouse.move(hb["x"] - 10 + (hb["width"] + 20) * k / 8, hb["y"] + hb["height"] / 2 + (k % 2) * 4)
        page.mouse.move(hb["x"] + hb["width"] + 10, hb["y"] + hb["height"] / 2); page.mouse.up()
        ok("dragging on the preview draws a red mark", page.locator(".drawlayer path").count() == 1 and "1 mark" in page.locator(".drawbar").inner_text())
        page.get_by_title("Undo last mark").click()
        ok("a mark can be undone", page.locator(".drawlayer path").count() == 0)
        page.mouse.move(hb["x"] - 10, hb["y"] + hb["height"] / 2); page.mouse.down()
        for k in range(1, 9):
            page.mouse.move(hb["x"] - 10 + (hb["width"] + 20) * k / 8, hb["y"] + hb["height"] / 2 + (k % 2) * 4)
        page.mouse.up()
        page.get_by_label("Describe the change").fill("make this heading red")
        page.get_by_role("button", name="Copy prompt").click()
        ok("the drawing is sent with the marked element, its file and line, and the request",
           wait_for(lambda: "[Forge drawing annotation]" in cur() and "make this heading red" in cur() and "<h1>" in cur() and "src/App.tsx" in cur(), 5), cur()[:300])
        ok("sending clears the marks", wait_for(lambda: page.locator(".drawlayer path").count() == 0, 3))
        page.keyboard.press("Escape")
        ok("Escape stops drawing", wait_for(lambda: page.locator(".drawlayer").count() == 0, 3))

        # ------------------------------------------------------------------ G. Comment tool: popover on the element, pins, tray
        page.get_by_title("Comment on an element (C)").click()
        frame.locator("button").first.click()
        pop = page.locator(".ebar.comment")
        expect(pop).to_be_visible()
        pb, bt = pop.bounding_box(), frame.locator("button").first.bounding_box()
        ok("comment popover appears at the element", abs((pb["y"] + pb["height"]) - bt["y"]) <= 24 or abs(pb["y"] - (bt["y"] + bt["height"])) <= 24)
        pop.locator("textarea").fill("Make this button larger")
        page.screenshot(path=f"{SHOTS}/26-comment.png")
        pop.get_by_role("button", name="Add comment").click()
        pin = page.locator(".pin").first
        expect(pin).to_be_visible()
        time.sleep(0.3)
        pn, bt = pin.bounding_box(), frame.locator("button").first.bounding_box()
        ok("a numbered pin is placed where you clicked on the element",
           abs(pn["x"] + 11 - (bt["x"] + bt["width"] / 2)) <= 16 and abs(pn["y"] + 11 - (bt["y"] + bt["height"] / 2)) <= 16 and pin.inner_text() == "1", f"pin={pn} btn={bt}")
        frame.locator("h1").click()
        page.locator(".ebar.comment textarea").fill("Heading too bold")
        page.locator(".ebar.comment").get_by_role("button", name="Add comment").click()
        ok("two pins and a tray with the count", wait_for(lambda: page.locator(".pin").count() == 2, 3) and "2" in page.locator(".tray").inner_text())
        page.locator(".pin").first.click()
        ok("clicking a pin shows its comment", "Make this button larger" in page.locator(".pincard").inner_text())
        page.locator(".pincard").get_by_role("button", name="Delete").click()
        ok("a comment can be deleted", wait_for(lambda: page.locator(".pin").count() == 1, 3))
        page.screenshot(path=f"{SHOTS}/27-pins.png")
        page.locator(".tray").get_by_role("button", name="Copy prompt").click()
        ok("Send puts all comments into one prompt with file and line",
           wait_for(lambda: "[Forge review comments]" in cur() and "Heading too bold" in cur() and "src/App.tsx" in cur(), 3))
        ok("comments are cleared after sending", wait_for(lambda: page.locator(".pin").count() == 0 and page.locator(".tray").count() == 0, 3))
        page.get_by_title("Comment on an element (C)").click()  # tool off

        # ------------------------------------------------------------------ H. floating toolbar
        page.mouse.move(5, 5)
        op = lambda: float(page.locator(".toolbar .extras").evaluate("e => getComputedStyle(e).opacity"))  # noqa: E731
        time.sleep(0.4)
        ok("More and the minimize arrow are hidden until the cursor enters the toolbar", op() == 0.0)
        ok("Select, Text, Comment are always visible", all(page.get_by_title(t).is_visible() for t in ("Select an element (V)", "Edit text (T)", "Comment on an element (C)")))
        page.locator(".toolbar").hover()
        time.sleep(0.4)
        ok("hovering the toolbar reveals More and the minimize arrow", op() == 1.0 and page.get_by_title("More").is_visible() and page.get_by_title("Minimize toolbar").is_visible())
        page.get_by_title("Minimize toolbar").click()
        expect(page.locator(".side-dock")).to_be_visible()
        ok("minimize moves the toolbar to the side and shows a Dock button", page.locator(".toolbar").count() == 0 and "Dock" in page.locator(".side-dock").inner_text())
        page.locator(".side-dock").click()
        ok("Dock brings the toolbar back", page.locator(".toolbar").count() == 1)
        page.locator(".toolbar").hover()
        page.get_by_title("More").click()
        ok("menu has Dock / Minimize / Hide / themes / shortcuts / version",
           all(page.get_by_role("button", name=n).count() for n in ("Dock", "Minimize", "Hide", "Auto", "Light", "Dark"))
           and page.get_by_text("Keyboard shortcuts").count() == 1 and page.get_by_text("Forge v0.2.0").count() == 1)
        page.get_by_role("button", name="Dark").click()
        ok("Dark theme applies", page.evaluate("document.documentElement.dataset.theme") == "dark")
        page.screenshot(path=f"{SHOTS}/28-dark.png")
        page.get_by_role("button", name="Light").click()
        page.get_by_role("button", name="Hide").click()
        ok("Hide removes the toolbar", page.locator(".toolbar").count() == 0)
        page.get_by_label("Show toolbar").click()
        ok("toolbar can be restored", page.locator(".toolbar").count() == 1)
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("t")
        ok("shortcut T activates the text tool", "active" in (page.get_by_title("Edit text (T)").get_attribute("class") or ""))
        page.keyboard.press("Escape")
        ok("Esc leaves the tool", "active" not in (page.get_by_title("Edit text (T)").get_attribute("class") or ""))
        page.get_by_role("tab", name="Code").click()
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("/")
        ok("'/' focuses the search bar on Code / Files / Layers", page.evaluate("document.activeElement && document.activeElement.getAttribute('aria-label')") == "Search")
        page.get_by_role("tab", name="Preview").click()

        # ------------------------------------------------------------------ I. conflict, versions, copy, new tab, download, expand, collapse
        page.get_by_role("tab", name="Code").click()
        page.locator(".tree .row.file", has_text="App.tsx").first.locator(".row-main").click()
        page.locator(".cm-content").click()
        page.keyboard.type("// my local edit\n")
        api("forge_ui_save", project=PROJECT, path="src/App.tsx", content=disk() + "// ai edit\n")
        page.keyboard.press("Control+s")
        expect(page.get_by_text("changed (by the AI or elsewhere)")).to_be_visible(timeout=10_000)
        ok("save is refused with a conflict banner when the AI changed the file", True)
        page.get_by_role("button", name="Load their version").click()
        before = len(rest_hist())
        page.get_by_title("Version history").click()
        expect(page.locator(".versions .version").first).to_be_visible()
        ok("version history lists the changes (who, what, when)", page.locator(".versions .version").count() >= 3 and "AI" in page.locator(".versions").inner_text())
        page.locator(".versions .version").nth(1).get_by_role("button", name="Restore").click()
        ok("Restore goes back to that version (one change undone)", wait_for(lambda: len(rest_hist()) == before - 1, 5), f"{before} -> {len(rest_hist())}")
        page.get_by_role("tab", name="Code").click()
        page.locator(".tree .row.file", has_text="App.tsx").first.locator(".row-main").click()
        page.get_by_title("Copy file").click()
        ok("Copy puts the file's code on the clipboard", wait_for(lambda: "export default function App" in cur(), 3))
        page.get_by_role("tab", name="Preview").click()
        ok("Preview shows no undo/redo/history", page.get_by_title("Version history").count() == 0 and page.get_by_title("Undo").count() == 0)
        with ctx.expect_page() as popup:
            page.get_by_title("Open preview in a new tab").click()
        newtab = popup.value
        newtab.wait_for_load_state()
        ok("Open in new tab shows the running app", newtab.locator("h1").count() == 1)
        newtab.close()
        page.get_by_role("tab", name="Files").click()
        with page.expect_download(timeout=20_000) as dl:
            page.get_by_title("Download project (.zip)").click()
        page.get_by_role("tab", name="Preview").click()
        ok("Download gives a real zip of the project", open(dl.value.path(), "rb").read(2) == b"PK" and dl.value.suggested_filename == f"{PROJECT}.zip")
        page.get_by_title("Expand").click()
        ok("Expand takes the window full screen", wait_for(lambda: page.evaluate("!!document.fullscreenElement"), 3))
        ok("the icon changes to 'Exit full screen'", wait_for(lambda: page.get_by_title("Exit full screen").is_visible(), 4))
        page.get_by_title("Exit full screen").click()
        ok("and it can be left again", wait_for(lambda: not page.evaluate("!!document.fullscreenElement"), 3))
        page.get_by_title("Collapse").click()
        ok("close collapses to a reopen button", page.get_by_label("Open Forge preview").count() == 1)
        page.get_by_label("Open Forge preview").click()
        ok("no uncaught page errors", not errors, str(errors[:2]))
    except BaseException:
        page.screenshot(path=f"{SHOTS}/zz-failure.png")
        raise
    finally:
        browser.close()

print(f"\n{N} UI checks passed. Screenshots in {SHOTS}")
