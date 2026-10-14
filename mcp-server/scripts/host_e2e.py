"""End-to-end test of the Forge workbench running AS AN MCP APP inside a spec-conformant host.

The host is web-app/host-test (built on the official SDK's AppBridge): it connects to Forge over Streamable HTTP,
reads ui://forge/workbench, renders it in a sandboxed iframe under the spec's default CSP, and records what the app
asks of its host. Needs: a running Forge server (FORGE_CORS must allow the host origin), the harness served on :3100.

    python3 scripts/host_e2e.py [forge-url] [host-url]
"""
import json
import re
import os
import sys
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

FORGE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
HOST = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:3100").rstrip("/")
PROJECT = "host-test"
SHOTS = os.path.join(os.getcwd(), "ui-shots")
os.makedirs(SHOTS, exist_ok=True)
N = 0


def wf_open(page, view):
    for _ in range(40):
        if view.get_by_role("tab").count() >= 1 and "fullscreen" in page.evaluate("window.__host.displayModes"):
            return True
        time.sleep(0.2)
    return False


def ok(name, cond, detail=""):
    global N
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        raise SystemExit(1)
    N += 1


def rest(tool, **args):
    req = urllib.request.Request(f"{FORGE}/api/tool/{tool}", data=json.dumps(args).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


APP = '''export default function App() {
  return (
    <main className="min-h-screen bg-slate-50 p-10">
      <h1 className="text-4xl font-bold text-slate-900">Hello from host</h1>
      <p className="mt-2 text-slate-600">Rendered inside an MCP App.</p>
    </main>
  );
}
'''

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context(viewport={"width": 1180, "height": 820}, accept_downloads=True).new_page()
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))
    page.goto(f"{HOST}/?server={FORGE}")
    page.wait_for_function("window.__err || (window.__host && window.__host.ready)", timeout=30_000)
    ok("host connected to the Forge MCP server", page.evaluate("!window.__err"), str(page.evaluate("window.__err")))

    # --- protocol: what a real host discovers --------------------------------------------------
    tools = {t["name"]: t["ui"] for t in page.evaluate("window.__host.tools")}
    ok("tool forge_write_files links the ui:// resource and is visible to the model",
       tools["forge_write_files"]["resourceUri"] == "ui://forge/workbench" and "model" in tools["forge_write_files"]["visibility"])
    ok("window-only tools are marked app-only (hidden from the model)", tools["forge_ui_sources"]["visibility"] == ["app"])
    ok("ui:// resource uses the MCP Apps MIME type", page.evaluate("window.__host.resourceMeta.mimeType") == "text/html;profile=mcp-app")

    view = page.frame_locator("#view")
    nested = view.frame_locator("iframe[title='App preview']")

    # --- the AI "writes" files: streaming partial input, then the result ----------------------------------
    args = {"project": PROJECT, "files": [{"path": "src/App.tsx", "content": APP}]}
    partials = [
        {"project": PROJECT, "files": [{"path": "src/App.tsx", "content": "export default function App() {\n  return ("}]},
        {"project": PROJECT, "files": [{"path": "src/App.tsx", "content": APP[:200]}]},
    ]
    page.evaluate("(a) => { window.__run = window.__host.run('forge_write_files', a.args, a.partials); }", {"args": args, "partials": partials})
    expect(view.get_by_role("tab", name="Code")).to_be_visible(timeout=15_000)
    ok("Forge opens by itself in the large preview panel as soon as the AI starts writing (no click on a card)",
       view.get_by_label("Open Forge preview").count() == 0 and "fullscreen" in page.evaluate("window.__host.displayModes"))
    expect(view.get_by_role("tab", name="Code")).to_have_attribute("aria-selected", "true", timeout=15_000)
    ok("window handshake completed (ui/initialize -> initialized)", page.evaluate("window.__host.initialized"))
    expect(view.locator(".cm-content")).to_contain_text("export default function App", timeout=10_000)
    expect(view.get_by_text("AI is writing")).to_be_visible()
    ok("Code tab streams the AI's code while it is being generated (tool-input-partial)", True)
    page.screenshot(path=f"{SHOTS}/10-host-streaming.png")
    page.evaluate("window.__run")
    ok("Code tab is never empty right after the AI finishes (its files stay visible until the editor opens one)",
       view.get_by_text("Select a file").count() == 0 and (view.locator(".tree .row.file").count() >= 1 or view.get_by_role("tab", name="Preview").get_attribute("aria-selected") == "true"))

    expect(nested.locator("h1")).to_have_text("Hello from host", timeout=90_000)
    ok("after the tool result the app builds and shows the live preview", True)
    ok("the window returns to the Preview tab by itself", view.get_by_title("Reload preview").is_visible())
    page.screenshot(path=f"{SHOTS}/11-host-preview.png")

    # --- select an element and prompt the AI: must arrive in the HOST's chat (ui/message) -----------------
    view.get_by_title("Select an element (V)").click()
    nested.locator("h1").click()
    ok("no edit bar appears on selection inside the host", view.locator(".ebar[role=toolbar]").count() == 0)
    ok("inside a host there is no prompt box or chip of our own", view.locator(".composer").count() == 0)
    time.sleep(2)
    ok("by default selecting posts nothing into the host's chat (so the host never asks to replace text)",
       page.evaluate("window.__host.messages.length") == 0)
    for _ in range(30):
        if page.evaluate("window.__host.contexts.length"):
            break
        time.sleep(0.2)
    ctx = json.dumps(page.evaluate("window.__host.contexts"), ensure_ascii=False)
    ok("the details (element, file, line) still travel as model context (ui/update-model-context)", "<h1>" in ctx and "src/App.tsx" in ctx and "⬚ h1" in ctx, ctx[:200])

    # --- opt in: More -> "Post selection to chat" puts just a chip with the tag name into the host's chat ------
    view.locator(".toolbar").hover()  # the extras (More, Minimize) show while the pointer is on the toolbar
    view.get_by_title("More").click()
    view.locator("label.menu-item", has_text="Post selection to chat").click(force=True)
    view.get_by_title("More").click()
    if "active" not in (view.get_by_title("Select an element (V)").get_attribute("class") or ""): view.get_by_title("Select an element (V)").click()
    nested.locator("p").first.click() if nested.locator("p").count() else nested.locator("h1").click(position={"x": 3, "y": 3})
    for _ in range(30):
        if page.evaluate("window.__host.messages.length"):
            break
        time.sleep(0.2)
    msgs = page.evaluate("window.__host.messages")
    text = msgs[0]["content"][0]["text"] if msgs else ""
    ok("with the option on, selecting posts just a chip with the tag name (no long text)",
       msgs and msgs[0]["role"] == "user" and text.strip().startswith("⬚ ") and len(text) < 20, text[:200])

    # --- visual edit travels app -> host -> MCP server (tools/call), file changes on the server --------------------
    view.get_by_title("Edit text (T)").click()
    nested.locator("h1").click()
    for _ in range(30):
        if nested.locator("h1").get_attribute("contenteditable") is not None:
            break
        time.sleep(0.2)
    ok("the Text tool edits the heading in place, inside the host's sandbox", nested.locator("h1").get_attribute("contenteditable") is not None)
    page.keyboard.insert_text("Edited through the host")
    page.keyboard.press("Enter")
    expect(nested.locator("h1")).to_have_text("Edited through the host", timeout=30_000)
    for _ in range(40):
        if "Edited through the host" in rest("forge_ui_read", project=PROJECT, path="src/App.tsx")["content"]:
            break
        time.sleep(0.25)
    ok("the in-place text edit reached the server through the host's tools/call proxy",
       "Edited through the host" in rest("forge_ui_read", project=PROJECT, path="src/App.tsx")["content"])

    # --- Files tab: single-file download and "open in browser" are delegated to the HOST --------------------------------
    view.get_by_role("tab", name="Files (download)").click()
    view.get_by_title("Download src/App.tsx").click()
    for _ in range(30):
        if page.evaluate("window.__host.downloads.length"):
            break
        time.sleep(0.2)
    one = page.evaluate("window.__host.downloads")[0]["contents"][0]["resource"]
    ok("single file download is delegated to the host with that file's content",
       one["uri"].endswith("/App.tsx") and "Edited through the host" in __import__("base64").b64decode(one["blob"]).decode(), str(one)[:120])
    page.evaluate("window.__host.downloads.length = 0")
    view.get_by_role("tab", name="Preview").click()
    view.get_by_title("Open preview in a new tab").click()
    for _ in range(20):
        if page.evaluate("window.__host.links.length"):
            break
        time.sleep(0.2)
    ok("Open in browser asks the host to open the project's /ui link (ui/open-link)",
       page.evaluate("window.__host.links")[0]["url"] == f"{FORGE}/ui?project={PROJECT}", str(page.evaluate("window.__host.links")))

    # --- download goes through the HOST (sandboxed iframes cannot download directly) -------------------------------------
    view.get_by_role("tab", name="Files").click()
    view.get_by_title("Download project (.zip)").click()
    for _ in range(30):
        if page.evaluate("window.__host.downloads.length"):
            break
        time.sleep(0.2)
    d = page.evaluate("window.__host.downloads")
    res = d[0]["contents"][0]["resource"] if d else {}
    ok("download is delegated to the host (ui/download-file) with a real zip",
       res.get("mimeType") == "application/zip" and str(res.get("blob", "")).startswith("UEs"), str(res)[:150])

    # --- display mode + theme driven by the host ------------------------------------------------------------------------------
    time.sleep(0.5)  # Forge asks for fullscreen by itself once a generation finishes
    if view.get_by_title("Expand").count():
        view.get_by_title("Expand").click(); time.sleep(0.5)
    ok("fullscreen is requested from the host and applied", "fullscreen" in page.evaluate("window.__host.displayModes")
       and view.locator("html.fs").count() == 1)
    page.evaluate("window.__host.setTheme('dark')")
    time.sleep(0.4)
    ok("host theme changes are followed (light -> dark)", view.locator("html").get_attribute("data-theme") == "dark")
    page.screenshot(path=f"{SHOTS}/12-host-dark.png")

    # --- draw annotation travels into the host's chat, with the marked element and a wireframe picture -------------------------
    before = page.evaluate("window.__host.messages.length")
    view.get_by_role("tab", name="Preview").click()
    expect(nested.locator("h1")).to_be_visible(timeout=20_000)
    view.get_by_title("Draw annotation (D)").click()
    hb = nested.locator("h1").bounding_box()
    page.mouse.move(hb["x"] - 8, hb["y"] + hb["height"] / 2); page.mouse.down()
    for k in range(1, 9):
        page.mouse.move(hb["x"] - 8 + (hb["width"] + 16) * k / 8, hb["y"] + hb["height"] / 2 + (k % 2) * 4)
    page.mouse.up()
    ok("draw has no prompt box of its own in a host", view.get_by_label("Describe the change").count() == 0 and view.get_by_role("button", name="Send to AI").count() == 0)
    for _ in range(40):
        if page.evaluate("window.__host.messages.length") > before:
            break
        time.sleep(0.2)
    last = page.evaluate("window.__host.messages")[-1]["content"]
    ltext = last[0]["text"]
    ok("a drawing lands in the host's chat as a short marker (like Select), without typing", ltext.startswith("\u270e h1"), ltext[:300])
    ctx = json.dumps(page.evaluate("window.__host.contexts"), ensure_ascii=False)
    ok("...and the details (marked element, file) go to the model as context", "src/App.tsx" in ctx and "\u270e" in ctx, ctx[-300:])
    ok("...with a picture of the marks attached (image content block)", any(c.get("type") == "image" and c.get("mimeType") == "image/png" for c in last), str([c.get("type") for c in last]))
    page.keyboard.press("Escape")

    # --- the AI makes a document: the window shows only that document, with no tabs and no library -----------------------------
    page.evaluate("""() => { window.__run = window.__host.run('forge_create_document', {name: 'Host report', format: 'md', content: '# Host report\\n\\nHello from a document.', project: '%s'}); }""" % PROJECT)
    expect(view.locator(".doc-title")).to_have_value(re.compile("Host report"), timeout=20_000)
    ok("a generated document opens on its own", True)
    ok("document view has no app tabs, no device buttons, no library list",
       view.get_by_role("tab").count() == 1 and view.get_by_title("Device").count() == 0 and view.locator(".doc-list").is_hidden() and view.get_by_title("Back to the app").count() == 1)
    ok("document view offers its own options (title, versions, export; autosaves, no Save button)",
       view.get_by_title("Document versions").count() == 1 and view.get_by_role("button", name="Export").count() == 1 and view.get_by_role("button", name="Save").count() == 0 and view.locator(".doc-title").input_value().startswith("Host report"))
    ok("no prompt input of our own in a host document either (the chat is the host's)", view.locator(".askbar input").count() == 0)
    page.screenshot(path=f"{SHOTS}/13-host-document.png")
    view.get_by_title("Back to the app").click()
    ok("Back to the app restores preview/code/files/layers tabs (no Docs tab)",
       view.get_by_role("tab", name="Preview").count() == 1 and view.get_by_role("tab", name="Docs").count() == 0)

    # --- the strict default CSP produced no violations -------------------------------------------------------------------------
    csp = [e for e in console_errors if "Content Security Policy" in e or "Refused to" in e]
    ok("no CSP violations under the spec's default policy", not csp, "; ".join(csp[:2]))
    other = [e for e in console_errors if e not in csp]
    ok("no other console errors", not other, "; ".join(other[:2]))
    browser.close()

print(f"\n{N} host-mode checks passed. Screenshots in {SHOTS}")
