import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBridge } from "./bridge";
import type { Bridge, Handlers, ToolInput, ToolResult } from "./bridge";
import type {
  Changes, Comment, Described, Device, Dock, FileData, LayerNode, LiveFile, ProjectState,
  SaveResult, Sel, Tab, ThemePref, Tool, VersionEntry, ExportFile, SearchMatch,
} from "./types";
import { TopBar } from "./components/TopBar";
import { Icon } from "./components/Icon";
import { FloatingToolbar } from "./components/FloatingToolbar";
import { compileProject } from "./preview/compile";
import { PreviewPane } from "./components/PreviewPane";
import { CodeWorkspace } from "./components/CodeWorkspace";
import { DownloadFiles } from "./components/DownloadFiles";
import { copyText, fuzzy } from "./util";
import { LayersPanel } from "./components/LayersPanel";
import { DocsPane } from "./components/DocsPane";
import type { Env } from "./components/docs/env";
import type { DocSelection, ToolPos } from "./types";
import { TextHint } from "./components/ElementBar";
import { Composer } from "./components/Composer";
import { DrawLayer } from "./components/DrawLayer";
import { buildPrompt, probePoints, renderWireframe } from "./lib/annotate";
import type { Hit, Stroke } from "./lib/annotate";
import { CommentLayer } from "./components/CommentLayer";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const store = {
  get(k: string, d: string) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* sandboxed iframes may block storage */ } },
};

export default function App() {
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [project, setProject] = useState("");
  const [st, setSt] = useState<ProjectState | null>(null);
  const [tab, setTab] = useState<Tab>(() => { const t = new URLSearchParams(location.search).get("tab"); return (["preview", "files", "code", "layers", "docs"] as string[]).includes(t ?? "") && window.parent === window ? (t as Tab) : "preview"; });
  const [device, setDevice] = useState<Device>("desktop");
  const [route, setRoute] = useState("/");
  const [tool, setTool] = useState<Tool>("browse");
  const [dock, setDock] = useState<Dock>("dock");
  const [toolPos, setToolPos] = useState<ToolPos>(() => { const v = store.get("forge.toolPos", "auto"); return (["auto", "top", "bottom", "left", "right"].includes(v) ? v : "auto") as ToolPos; });
  useEffect(() => { store.set("forge.toolPos", toolPos); }, [toolPos]);
  const [themePref, setThemePref] = useState<ThemePref>(store.get("forge.theme", "auto") as ThemePref);
  const [hostTheme, setHostTheme] = useState<"light" | "dark" | undefined>();
  const [shortcuts, setShortcuts] = useState(store.get("forge.shortcuts", "1") === "1");
  const [postSel, setPostSel] = useState(store.get("forge.postSel2", "0") === "1");
  const lastPosted = useRef("");
  const [displayMode, setDisplayMode] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState(false);
  const [card, setCard] = useState<{ title: string; sub: string; library?: boolean } | null>(null);

  const [html, setHtml] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [, setLayers] = useState<LayerNode[]>([]);

  const [sel, setSel] = useState<Sel | null>(null);
  const [, setDescribed] = useState<Described | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [busy, setBusy] = useState(false);

  const [file, setFile] = useState<FileData | null>(null);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  const [touched, setTouched] = useState<Record<string, number>>({});

  const [live, setLive] = useState<LiveFile[]>([]);
  const [liveActive, setLiveActive] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);

  const [textEditing, setTextEditing] = useState(false);
  const [queries, setQueries] = useState({ files: "", code: "", layers: "", docs: "" });
  const [codeResults, setCodeResults] = useState<{ matches: SearchMatch[]; truncated: boolean; files: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [browserFs, setBrowserFs] = useState(false);
  // What the window shows depends on what the AI made: "app" (preview/code/files/layers), "doc" (just that document, image, chart or diagram), "all" (everything).
  const [view, setView] = useState<"app" | "doc" | "all">(() => (window.parent === window && new URLSearchParams(location.search).get("tab") === "docs" ? "all" : "app"));
  const [docsSeen, setDocsSeen] = useState(false);
  const [docsRefresh, setDocsRefresh] = useState(0);
  const [openDoc, setOpenDoc] = useState<{ id: string; nonce: number } | null>(null);
  const [docsDirty, setDocsDirty] = useState(false);
  const docSel = useRef<DocSelection | null>(null);
  const docSelTimer = useRef<number | undefined>(undefined);
  const docsSave = useRef<(() => Promise<boolean>) | null>(null);
  const askRef = useRef<((t: string) => Promise<void>) | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selRef = useRef<Sel | null>(null);
  const toolRef = useRef<Tool>("browse");
  const pending = useRef<Changes>({});
  const flushTimer = useRef<number | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const buildSeq = useRef(0);
  const buildTimer = useRef<number | undefined>(undefined);
  const switchAfterBuild = useRef(false);
  const act = useRef<Handlers | null>(null);

  const dark = (themePref === "auto" ? hostTheme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : themePref) === "dark";
  const dirty = file !== null && draft !== file.content;
  selRef.current = sel;
  toolRef.current = tool;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const fileRef = useRef<FileData | null>(null);
  fileRef.current = file;
  const say = useCallback((m: string) => setToast(m), []);

  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => { document.documentElement.classList.toggle("fs", displayMode === "fullscreen" || bridge?.kind === "standalone"); }, [displayMode, bridge]);
  useEffect(() => { document.documentElement.classList.toggle("expanded", expanded && displayMode !== "fullscreen"); }, [expanded, displayMode]);
  useEffect(() => {
    const f = () => setBrowserFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);
  useEffect(() => { store.set("forge.theme", themePref); }, [themePref]);
  useEffect(() => { store.set("forge.shortcuts", shortcuts ? "1" : "0"); }, [shortcuts]);
  useEffect(() => { document.documentElement.classList.toggle("hostchat", bridge?.kind === "mcp"); }, [bridge]);
  useEffect(() => { store.set("forge.postSel2", postSel ? "1" : "0"); }, [postSel]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 4500); return () => clearTimeout(t); } }, [toast]);
  useEffect(() => {
    const t = setInterval(() => setTouched((c) => {
      const now = Date.now();
      const n = Object.fromEntries(Object.entries(c).filter(([, at]) => now - at < 6000));
      return Object.keys(n).length === Object.keys(c).length ? c : n;
    }), 1000);
    return () => clearInterval(t);
  }, []);

  // ---------------------------------------------------------------- data
  const call = useCallback(<T,>(name: string, args: Record<string, unknown> = {}) => {
    if (!bridge) return Promise.reject(new Error("Not connected"));
    return bridge.call<T>(name, { project, ...args });
  }, [bridge, project]);

  const refreshState = useCallback(async () => {
    try { setSt(await call<ProjectState>("forge_ui_state")); } catch (e) { say(errMsg(e)); }
  }, [call, say]);

  // The app is compiled right here in the window (like Claude Artifacts): fetch the source files, compile, show. Nothing runs on a server.
  const doBuild = useCallback(async (_force = false) => {
    if (!bridge || !project) return;
    const seq = ++buildSeq.current;
    setBuilding(true);
    try {
      const src = await call<{ files: Record<string, string>; rev: number }>("forge_ui_sources");
      if (seq !== buildSeq.current) return; // a newer build superseded this one
      if (Object.keys(src.files).length === 0) { setHtml(null); setBuildError(null); return; } // nothing generated yet: an empty page
      await new Promise((res) => setTimeout(res, 0)); // let "Updating…" paint before the (synchronous) compile
      const out = compileProject(src.files);
      if (seq !== buildSeq.current) return;
      if (out.ok && out.html) {
        setHtml(out.html); setBuildError(null); setRuntimeError(null);
        if (switchAfterBuild.current) { switchAfterBuild.current = false; setTab("preview"); }
        void call("forge_ui_report", { rev: src.rev }).catch(() => undefined);
      } else {
        const msg = out.error ?? "The build failed";
        setBuildError(msg);
        void call("forge_ui_report", { build_error: msg, rev: src.rev }).catch(() => undefined);
      }
    } catch (e) {
      if (seq === buildSeq.current) setBuildError(errMsg(e));
    } finally {
      if (seq === buildSeq.current) setBuilding(false);
    }
  }, [bridge, project, call]);

  const requestBuild = useCallback((delay = 350, force = false) => {
    window.clearTimeout(buildTimer.current);
    buildTimer.current = window.setTimeout(() => void doBuild(force), delay);
  }, [doBuild]);

  const openFile = useCallback(async (path: string, line?: number) => {
    try {
      const f = await call<FileData>("forge_ui_read", { path });
      setFile(f); setDraft(f.content); setConflict(false);
      if (line) setReveal({ line, nonce: Date.now() });
    } catch (e) { say(errMsg(e)); }
  }, [call, say]);

  const loadProject = useCallback((id: string) => {
    setProject(id); setHtml(null); setBuildError(null); setSel(null); setFile(null); setDraft(""); setComments([]); setRoute("/");
  }, []);

  // when the project changes (or the bridge becomes ready) load its state and build the preview
  useEffect(() => {
    if (!bridge || !project) return;
    void refreshState();
    void doBuild(false);
  }, [bridge, project]); // eslint-disable-line react-hooks/exhaustive-deps

  // this project is empty but the AI put its app in another project: open that one instead of an empty page
  useEffect(() => {
    if (st?.blank && st.suggest && st.project === project) loadProject(st.suggest);
  }, [st, project, loadProject]);

  // ---------------------------------------------------------------- host events (MCP) / bootstrap
  const changedByAi = useCallback((paths: string[]) => {
    setTouched((t) => ({ ...t, ...Object.fromEntries(paths.map((p) => [p, Date.now()])) }));
    void refreshState();
    if (file && paths.includes(file.path)) {
      if (!dirty) void openFile(file.path); else setConflict(true);
    }
  }, [file, dirty, refreshState, openFile]);

  const handlers = useMemo<Handlers>(() => ({
    onToolInput: (a: ToolInput) => act.current?.onToolInput(a),
    onToolInputPartial: (a: ToolInput) => act.current?.onToolInputPartial(a),
    onToolResult: (r: ToolResult) => act.current?.onToolResult(r),
    onTheme: (t) => setHostTheme(t),
    onDisplayMode: (m) => setDisplayMode(m),
  }), []);

  const mapFiles = (a: ToolInput, done: boolean): LiveFile[] => {
    const list = Array.isArray(a?.files) ? (a!.files as Array<{ path?: unknown; content?: unknown }>) : [];
    return list.filter((f) => f && typeof f.path === "string" && f.path).map((f, i) => ({
      path: String(f.path), content: typeof f.content === "string" ? f.content : "", done: done || i < list.length - 1,
    }));
  };
  // Like Claude's artifacts, Forge opens by itself in the large preview panel as soon as the AI starts writing; the small card is only
  // what remains after the window is closed. If the host refuses the larger display mode the window simply opens inline.
  const autoOpened = useRef(false);
  const openWindow = (fullscreen = true) => {
    setCollapsed(false);
    if (fullscreen && bridge?.canFullscreen) void bridge.setFullscreen(true).then((m) => m && setDisplayMode(m)).catch(() => undefined);
  };
  act.current = {
    onTheme: handlers.onTheme, onDisplayMode: handlers.onDisplayMode,
    onToolInputPartial: (a) => {
      const files = mapFiles(a, false);
      if (files.length === 0) return;
      if (!autoOpened.current) { autoOpened.current = true; openWindow(); }
      setLive(files); setLiveActive(files[files.length - 1].path); setStreaming(true); setView((v) => (v === "all" ? v : "app")); setTab("code");
    },
    onToolInput: (a) => {
      const files = mapFiles(a, true);
      if (files.length) { setLive(files); setLiveActive(files[files.length - 1].path); }
      setStreaming(false);
      if (typeof a?.project === "string") setProject(String(a.project).toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
    },
    onToolResult: (r) => {
      setStreaming(false);
      if (!autoOpened.current) openWindow(); // nothing streamed first (e.g. a short write): open now
      autoOpened.current = false;
      const sc = r.structuredContent as { project?: string; written?: { path: string }[]; tab?: Tab; autoBuild?: boolean; library?: { id: string; name: string; kind: string } } | undefined;
      if (!sc?.project) { setCard((c) => c ?? { title: project || "Forge", sub: "Updated · live preview" }); requestBuild(50); return; } // an edit made with a plain tool (write_file, update_component, undo…)
      setCard(sc.library ? { library: true, title: sc.library.name, sub: `${sc.library.kind.replace(/^\w/, (c) => c.toUpperCase())} · ready to view and edit` }
        : { title: sc.project, sub: sc.written?.length ? `${sc.written.length} file${sc.written.length === 1 ? "" : "s"} written · live preview` : "Live preview" });
      if (sc.library) { // the AI created or changed a document: open it in the Docs tab
        if (sc.project !== project) loadProject(sc.project);
        setOpenDoc({ id: sc.library.id, nonce: Date.now() }); setDocsRefresh((n) => n + 1); setView((v) => (v === "all" ? v : "doc")); setTab("docs");
        return;
      }
      const wrote = (sc.written ?? []).map((w) => w.path);
      if (wrote.length || sc.tab) setView((v) => (v === "doc" ? "app" : v));
      if (sc.project !== project) loadProject(sc.project); else { changedByAi(wrote); requestBuild(50); }
      if (wrote.length) { switchAfterBuild.current = true; setTouched((t) => ({ ...t, ...Object.fromEntries(wrote.map((p) => [p, Date.now()])) })); }
      else if (sc.tab) setTab(sc.tab);
    },
  };

  useEffect(() => {
    let alive = true;
    createBridge(handlers).then((b) => {
      if (!alive) return;
      setBridge(b);
      if (b.kind === "mcp") setCollapsed(true); // inside an AI app Forge first shows a small card under the message; it opens when clicked
      if (b.kind === "standalone") loadProject(b.project ?? "default");
      else window.setTimeout(() => setProject((p) => p || "default"), 2500); // opened without a tool result
    }).catch((e) => say(errMsg(e)));
    return () => { alive = false; };
  }, [handlers, loadProject, say]);

  // ---------------------------------------------------------------- actions
  const save = async (force = false) => {
    if (!file || !dirty || saving) return;
    setSaving(true);
    try {
      const r = await call<SaveResult>("forge_ui_save", { path: file.path, content: draft, base_hash: force ? null : file.hash });
      if (r.ok && r.hash) { setFile({ ...file, content: draft, hash: r.hash }); setConflict(false); void refreshState(); requestBuild(); }
      else if (r.conflict) setConflict(true);
      else say(r.error ?? "Could not save");
    } catch (e) { say(errMsg(e)); } finally { setSaving(false); }
  };

  const history = async (action: "undo" | "redo") => {
    try {
      const r = await call<{ ok: boolean; error?: string; path?: string }>("forge_ui_history", { action });
      if (!r.ok) { say(r.error ?? `Nothing to ${action}`); return; }
      await refreshState();
      if (file && !dirty) void openFile(file.path);
      requestBuild(100);
    } catch (e) { say(errMsg(e)); }
  };

  const download = async (path?: string) => {
    try { await bridge!.download(await call<ExportFile>("forge_ui_export", path ? { path } : {})); say("Download started"); } catch (e) { say(errMsg(e)); }
  };
  const copyFilePath = async (path: string) => {
    try {
      const f = await call<FileData>("forge_ui_read", { path });
      say((await copyText(f.content)) ? `Copied ${path}` : "Your browser blocked copying here. Use Download instead.");
    } catch (e) { say(errMsg(e)); }
  };
  const copyOpen = async () => { if (file) say((await copyText(draft)) ? `Copied ${file.path}` : "Your browser blocked copying here. Use Download instead."); };

  const loadVersions = async () => {
    try { setVersions((await call<{ entries: VersionEntry[] }>("forge_ui_history", { action: "list" })).entries); } catch (e) { say(errMsg(e)); }
  };
  const restoreVersion = async (keep: number) => {
    try {
      const r = await call<{ ok: boolean; error?: string; steps?: number }>("forge_ui_history", { action: "restore", keep });
      if (!r.ok) { say(r.error ?? "Could not restore"); return; }
      say(r.steps ? "Restored. Use Redo to go forward again." : "Already at that version");
      await refreshState();
      if (file && !dirty) void openFile(file.path);
      requestBuild(100);
    } catch (e) { say(errMsg(e)); }
  };

  const openBrowser = async () => {
    if (bridge?.kind === "standalone") {
      if (html) window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
    } else if (st?.public_url) {
      try { await bridge!.openLink(`${st.public_url}/ui?project=${encodeURIComponent(project)}`); } catch (e) { say(errMsg(e)); }
    }
  };
  const canOpenBrowser = bridge?.kind === "standalone" ? Boolean(html) : Boolean(st?.public_url);

  // The Code tab should never be empty: open a sensible default file when there is none.
  useEffect(() => {
    if (tab !== "code" || file || streaming || !st?.files.length) return;
    const pref = st.files.find((f) => f === "src/App.tsx") ?? st.files.find((f) => /^src\/.*\.(tsx|jsx)$/.test(f)) ?? st.files[0];
    void openFile(pref);
  }, [tab, file, streaming, st, openFile]);

  const post = (m: object) => frameRef.current?.contentWindow?.postMessage(m, "*");

  const applyTo = async (s: Sel, c: Changes): Promise<boolean> => {
    if (dirtyRef.current && fileRef.current?.path === s.path) { say("Save or revert your edits in the code editor first."); return false; }
    setBusy(true);
    try {
      const r = await call<{ ok: boolean; error?: string }>("forge_ui_edit", { path: s.path, line: s.line, col: s.col, changes: c });
      if (!r.ok) { say(r.error ?? "Could not apply"); return false; }
      await refreshState(); requestBuild(120);
      if (fileRef.current?.path === s.path) void openFile(s.path);
      return true;
    } catch (e) { say(errMsg(e)); return false; } finally { setBusy(false); }
  };

  const flush = async () => {
    window.clearTimeout(flushTimer.current);
    const s = selRef.current, c = pending.current;
    pending.current = {};
    if (!s || Object.keys(c).length === 0) return;
    await applyTo(s, c);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const beginTextEdit = (s: Sel, d: Described) => {
    if (d.ok && d.text !== null && d.text !== undefined) { post({ type: "forge:edit-text", src: s.src }); setTextEditing(true); }
    else { say("This element has no text of its own. Click the text itself to edit it."); setSel(null); setDescribed(null); }
  };

  const onSelect = (s: Sel) => {
    void flushRef.current();
    setSel(s); setDescribed(null); setTextEditing(false);
    call<Described>("forge_ui_describe", { path: s.path, line: s.line, col: s.col }).then((d) => {
      if (selRef.current?.src !== s.src) return;
      setDescribed(d);
      if (toolRef.current === "text") beginTextEdit(s, d);
    }).catch(() => setDescribed({ ok: false }));
    void bridge?.setContext(`The user selected <${s.tag}> at ${s.path}:${s.line}:${s.col} (classes: "${s.className}", text: "${s.text ?? ""}") in Forge project "${project}". ` +
      `A token like "⬚ ${s.tag}" in the user's next message means this element. Change nothing until the user says what to change; then edit it with the Forge tools.`);
    // inside an AI app the selection goes straight into the host's chat (no prompt box of our own); the user then types the change there
    if (bridge?.kind === "mcp" && postSel && toolRef.current === "select" && lastPosted.current !== s.src) {
      lastPosted.current = s.src;
      // Like Lovable: just a chip with the tag name in the chat box; file, line and text travel as model context (above), not as visible text.
      void bridge.sendPrompt(`⬚ ${s.tag} `).catch(() => undefined);
    }
  };
  const clearSel = () => { lastPosted.current = ""; void flushRef.current(); post({ type: "forge:cancel-edit" }); setSel(null); setDescribed(null); setTextEditing(false); };
  const escapeTool = () => { setTool("browse"); clearSel(); };

  const onTextCommit = async (src: string, text: string, changed: boolean) => {
    const s = selRef.current;
    setTextEditing(false); setSel(null); setDescribed(null);
    if (!changed || !s || s.src !== src) return;
    if (await applyTo(s, { text })) say("Text updated");
  };
  const onTextCancel = (_src: string, reason?: string) => {
    setTextEditing(false); setSel(null); setDescribed(null);
    if (reason === "not-editable") say("This element has no text of its own.");
  };
  const addComment = (text: string) => {
    const s = selRef.current;
    if (!s) return;
    setComments((cs) => [...cs, { id: Date.now(), sel: s, text }]);
    setSel(null); setDescribed(null);
    say("Comment added");
  };

  const ask = async (text: string, ctx?: { instruction: string; path: string; line: number; col: number }) => {
    if (!bridge) return;
    setBusy(true);
    try {
      const how = await bridge.sendPrompt(text, ctx);
      if (how === "sent") {
        say(bridge.kind === "mcp" ? "Sent to the AI in the chat" : "The AI applied your change");
        if (bridge.kind === "standalone") { await refreshState(); requestBuild(100); if (file) void openFile(file.path); }
      } else say("Copied. Paste it into your AI chat.");
    } catch (e) { say(errMsg(e)); } finally { setBusy(false); }
  };
  askRef.current = (t) => ask(t);
  const sendPrompt = (instruction: string) => {
    if (!sel) return;
    void ask([
      `[Forge edit request] Project "${project}".`,
      `Element: <${sel.tag}> at ${sel.path}:${sel.line}:${sel.col}. Classes: "${sel.className}". Text: "${sel.text ?? ""}".`,
      `Request: ${instruction}`,
      "Make this change with the Forge tools (forge_write_files for the file, or update_component for a small tweak to one element). Keep the rest of the app unchanged.",
    ].join("\n"), { instruction, path: sel.path, line: sel.line, col: sel.col });
  };
  /** The Draw tool: find the elements under the marks (the page answers "forge:probed"), then send the marks, a wireframe picture and the request. */
  const probeSeq = useRef(0);
  const probe = (points: { x: number; y: number }[]) => new Promise<{ vw: number; vh: number; items: (Hit & { i: number })[] }>((resolve) => {
    const id = ++probeSeq.current;
    const fail = window.setTimeout(() => { window.removeEventListener("message", on); resolve({ vw: 0, vh: 0, items: [] }); }, 900);
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: number; vw?: number; vh?: number; items?: (Hit & { i: number })[] };
      if (d?.type !== "forge:probed" || d.id !== id) return;
      window.clearTimeout(fail); window.removeEventListener("message", on);
      resolve({ vw: d.vw ?? 0, vh: d.vh ?? 0, items: d.items ?? [] });
    };
    window.addEventListener("message", on);
    post({ type: "forge:probe", id, points });
  });
  const sendDrawing = async (instruction: string, drawn: Stroke[], frame: { x: number; y: number; w: number; h: number }) => {
    if (!bridge) return false;
    const local = drawn.map((s) => s.map((p) => ({ x: Math.max(0, p.x - frame.x), y: Math.max(0, p.y - frame.y) })));
    const pts = probePoints(local);
    const r = await probe(pts);
    const hits: Hit[][] = local.map(() => []);
    for (const it of r.items) {
      const si = pts[it.i]?.s;
      if (si === undefined || hits[si].some((h) => h.src === it.src)) continue;
      hits[si].push(it);
    }
    hits.forEach((list) => list.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)); // innermost (smallest) first
    const vw = r.vw || Math.round(frame.w), vh = r.vh || Math.round(frame.h);
    const hostChat = bridge.kind === "mcp";
    const text = buildPrompt({ project, route, device, vw, vh, strokes: local, hits, instruction: instruction || "(The user will say what to change in their next chat message.)" });
    const png = renderWireframe(vw, vh, hits, local);
    if (hostChat) { // like Select: a short marker lands in the host chat box, the details go to the model as context
      // one chip per marked element (the innermost element under each mark), like Select: "✎ h1 ✎ button"
      const marked = hits.map((list) => list[0]).filter((h): h is Hit => Boolean(h)).filter((h, i, all) => all.findIndex((x) => x.src === h.src) === i).slice(0, 6);
      const chips = marked.length ? marked.map((h) => `✎ ${h.tag} `).join("") : "✎ drawing ";
      void bridge.setContext(`The user drew on the preview. Tokens like "✎ tag" in their next message mean the marked elements (several marks = several tokens). Change nothing until they say what to change.\n${text}`).catch(() => undefined);
      try { await bridge.sendPrompt(chips, undefined, png ? [{ mimeType: "image/png", base64: png }] : undefined); return true; }
      catch (e) { say(errMsg(e)); return false; }
    }
    setBusy(true);
    try {
      const how = await bridge.sendPrompt(text, undefined, png ? [{ mimeType: "image/png", base64: png }] : undefined);
      say(how === "sent" ? "Sent to the AI in the chat" : "Copied. Paste it into your AI chat.");
      return true;
    } catch (e) { say(errMsg(e)); return false; } finally { setBusy(false); }
  };
  const sendComments = () => {
    void ask([`[Forge review comments] Project "${project}". Please address each:`,
      ...comments.map((c, i) => `${i + 1}. <${c.sel.tag}> at ${c.sel.path}:${c.sel.line}:${c.sel.col}: ${c.text}`),
      "Use the Forge tools to make the changes."].join("\n"));
    setComments([]);
  };
  const fixError = () => {
    const err = runtimeError ? `Runtime error in the preview: ${runtimeError}` : `The build failed:\n${buildError}`;
    void ask(`[Forge] Project "${project}". ${err}\nPlease fix it with forge_write_files, then run forge_check.`);
  };

  // Expand: the host's full-screen mode when it has one; the browser's full screen when standalone; otherwise a taller window.
  const isExpanded = displayMode === "fullscreen" || browserFs || expanded;
  const toggleExpand = async () => {
    try {
      if (bridge?.canFullscreen) { const m = await bridge.setFullscreen(displayMode !== "fullscreen"); if (m) setDisplayMode(m); return; }
      if (bridge?.kind === "standalone") {
        if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();
        return;
      }
    } catch (e) { say(`Full screen is not available here (${errMsg(e)})`); }
    setExpanded((x) => !x);
  };

  // ---------------------------------------------------------------- search (Files: paths, Code: text, Layers: elements)
  const query = tab === "files" || tab === "code" || tab === "layers" || tab === "docs" ? queries[tab] : "";
  const setQuery = (v: string) => { if (tab === "files" || tab === "code" || tab === "layers" || tab === "docs") setQueries((q) => ({ ...q, [tab]: v })); };
  useEffect(() => {
    const q = queries.code.trim();
    if (tab !== "code" || q.length < 2) { setCodeResults(null); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try { const r = await call<{ matches: SearchMatch[]; truncated: boolean; files: number }>("forge_ui_search", { query: q }); if (alive) setCodeResults(r); }
      catch (e) { if (alive) say(errMsg(e)); }
      finally { if (alive) setSearching(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [queries.code, tab, call, st?.files, say]);
  const filesHit = useMemo(() => (queries.files.trim() ? (st?.files ?? []).filter((f) => fuzzy(queries.files, f)).length : 0), [queries.files, st?.files]);
  const searchInfo = tab === "files"
    ? { placeholder: "Search files by path…", summary: queries.files.trim() ? `${filesHit} of ${st?.files.length ?? 0} files` : `${st?.files.length ?? 0} files` }
    : tab === "code"
      ? { placeholder: "Search code and file names…", summary: codeResults ? `${codeResults.matches.length}${codeResults.truncated ? "+" : ""} matches in ${codeResults.files} files` : "" }
      : tab === "docs"
        ? { placeholder: "Search documents by name or type…", summary: "" }
        : { placeholder: "Search files and components…", summary: "" };

  // ---------------------------------------------------------------- keyboard shortcuts
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,.cm-editor,[contenteditable=true]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); void history(e.shiftKey ? "redo" : "undo"); return; }
      if (mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "v") setTool((x) => (x === "select" ? "browse" : "select"));
      else if (k === "t") setTool((x) => (x === "text" ? "browse" : "text"));
      else if (k === "d") setTool((x) => (x === "draw" ? "browse" : "draw"));
      else if (k === "c") setTool((x) => (x === "comment" ? "browse" : "comment"));
      else if (k === "escape") { escapeTool(); }
      else if (k === "/" && tab !== "preview") { e.preventDefault(); searchRef.current?.focus(); }
      else if (["1", "2", "3", "4", "5"].includes(k)) { if (k === "5") setView("all"); setTab((["preview", "files", "code", "layers", "docs"] as Tab[])[Number(k) - 1]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => { if (tab === "docs") setDocsSeen(true); }, [tab]);
  useEffect(() => { // a tab that this view does not offer falls back to the first one it does
    const allowed: Tab[] = view === "doc" ? ["docs"] : view === "app" ? ["preview", "code", "files", "layers"] : ["preview", "files", "code", "layers", "docs"];
    if (!allowed.includes(tab)) setTab(allowed[0]);
  }, [view, tab]);
  // the AI (or another window) may change documents: look for changes while the Docs tab is open
  useEffect(() => {
    if (tab !== "docs" || !bridge) return;
    const t = setInterval(() => setDocsRefresh((n) => n + 1), 6000);
    return () => clearInterval(t);
  }, [tab, bridge]);

  const sendLabel0 = bridge?.kind === "mcp" ? "Send to AI" : "Copy prompt";
  const docEnv = useMemo<Env>(() => ({
    dark, say, download: (f) => bridge!.download(f), canAsk: Boolean(bridge), askLabel: sendLabel0, hostChat: bridge?.kind === "mcp",
    openFile: (p, l) => { setTab("code"); void openFile(p, l); },
    onSelection: (s) => {
      docSel.current = s;
      window.clearTimeout(docSelTimer.current);
      docSelTimer.current = window.setTimeout(() => {
        if (!bridge || !project) return;
        bridge.call("forge_ui_doc_selection", { project, selection: s }).catch(() => undefined);
        void bridge.setContext(s ? `The user selected ${s.label} in document "${s.docName}" (${s.docId}) of Forge project "${project}". A token like "⬚ tag" in the user's next message refers to this selection. Change nothing until the user says what to change.` : "").catch(() => undefined);
      }, 400);
    },
    setContext: (text) => { void bridge?.setContext(text).catch(() => undefined); },
    postChip: (tag) => { if (bridge?.kind === "mcp" && postSel) void bridge.sendPrompt(`⬚ ${tag} `).catch(() => undefined); },
    post: async (text, images) => {
      if (!bridge) return false;
      setBusy(true);
      try {
        const how = await bridge.sendPrompt(text, undefined, images);
        say(how === "sent" ? "Sent to the AI in the chat" : "Copied. Paste it into your AI chat.");
        return true;
      } catch (e) { say(errMsg(e)); return false; } finally { setBusy(false); }
    },
    ask: async (instruction, s) => {
      if (!bridge) return;
      if (docsSave.current && !(await docsSave.current())) { say("Save your edits first, or resolve the conflict."); return; }
      const generated = s?.docId.startsWith("layers-");
      const lines = [`[Forge document edit] Project "${project}".`,
        s ? `Document: "${s.docName}" (id ${s.docId}, ${s.kind}). Selection: ${s.label}.` : "No selection: apply the request to the whole document.",
        ...(s?.text ? [`Selected text: """${s.text.slice(0, 1500)}"""`] : []), ...(s?.detail ? [`Selection details: ${s.detail.slice(0, 1200)}`] : []),
        `Request: ${instruction}`,
        generated ? "This is a diagram generated from the app's code. To change it, change the app with forge_write_files; the user can also edit it by hand in the Layers tab."
          : "Apply it with forge_replace_in_document for a small change, or forge_update_document for a larger one (charts and diagrams: pass the full updated spec). Read it first with forge_library_read, or call forge_get_doc_selection for exactly what is selected. Keep everything else unchanged."];
      void askRef.current?.(lines.join("\n"));
    },
  }), [dark, say, bridge, project, sendLabel0, openFile, postSel]); // eslint-disable-line react-hooks/exhaustive-deps

  const filesKey = useMemo(() => { const s = st?.sizes ?? {}; let h = 0; for (const [k, v] of Object.entries(s)) { h = (h * 31 + k.length * 7 + v) | 0; } return `${st?.files.length ?? 0}:${h}:${st?.rev ?? 0}`; }, [st]);

  // Standalone window: the AI (or another process) may write files; follow along and rebuild the preview.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (bridge?.kind !== "standalone" || !project) return;
    const t = setInterval(() => { if (!document.hidden) void refreshState(); }, 2500);
    return () => clearInterval(t);
  }, [bridge, project, refreshState]);
  useEffect(() => {
    if (bridge?.kind !== "standalone") return;
    // remember the last seen state per project; a different key in the same project means files changed -> rebuild
    const key = `${project}|${filesKey}`;
    const prev = lastKey.current;
    lastKey.current = key;
    if (prev !== null && prev !== key && prev.startsWith(`${project}|`)) { requestBuild(200); if (file && !dirtyRef.current) void openFile(file.path); }
  }, [filesKey, project]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendLabel = bridge?.kind === "mcp" ? "Send to AI" : bridge?.aiEdit ? "Edit with Claude" : "Copy prompt";

  if (collapsed) {
    const openCard = () => openWindow();
    return (
      <div className="collapsed">
        <button className="fcard" onClick={openCard} aria-label="Open Forge preview">
          <span className="fcard-ico"><Icon name="layers" size={20} /></span>
          <span className="fcard-txt"><b>{card?.library ? card.title : st?.title || (project && project !== "default" ? project : "Forge app")}</b><small>{card?.library ? card.sub : "Forge live preview"}</small></span>
          <span className="fcard-open">Open</span>
        </button>
      </div>
    );
  }
  return (
    <div className="wb">
      <TopBar view={view} setView={setView} tab={tab} setTab={setTab} device={device} setDevice={setDevice}
        routes={st?.routes ?? [{ path: "/", label: "Homepage" }]} route={route} setRoute={setRoute}
        projects={st?.projects ?? []} project={project} setProject={loadProject}
        building={building} onRefresh={() => requestBuild(0, true)}
        canUndo={Boolean(st?.history.can_undo)} canRedo={Boolean(st?.history.can_redo)}
        onUndo={() => void history("undo")} onRedo={() => void history("redo")}
        versions={versions} onOpenVersions={() => void loadVersions()} onRestore={(k) => void restoreVersion(k)}
        onOpenBrowser={() => void openBrowser()} canOpenBrowser={canOpenBrowser}
        docsDirty={docsDirty}
        onDownload={() => void download()} expanded={isExpanded} onExpand={() => void toggleExpand()} onClose={() => setCollapsed(true)}
        search={{ value: query, onChange: setQuery, placeholder: searchInfo.placeholder, summary: searchInfo.summary }} searchRef={searchRef} />

      <div className="body">
        <div className="pane" hidden={tab !== "preview"}>
          <PreviewPane blank={Boolean(st?.blank)} html={html} device={device} tool={tool} selectedSrc={sel?.src ?? null} route={route}
            tracked={comments.map((c) => c.sel.src)}
            building={building} buildError={runtimeError ? `Runtime error: ${runtimeError}` : building && !html ? null : buildError} frameRef={frameRef}
            onSelect={onSelect} onTree={setLayers} onRuntimeError={(m) => { setRuntimeError(m); void call("forge_ui_report", { runtime_error: m }).catch(() => undefined); }} onFix={fixError} onRoute={(r) => setRoute((cur) => (cur === r ? cur : r))} onOpenLink={(u) => void bridge?.openLink(u).catch((e) => say(errMsg(e)))}
            onTextCommit={(src, text, changed) => void onTextCommit(src, text, changed)} onTextCancel={onTextCancel}
            canFix={Boolean(bridge && (bridge.kind === "mcp" || bridge.aiEdit))}
            errorTitle={runtimeError ? "The app hit a runtime error" : html ? "Build failed. Showing the last working preview." : "The app did not build"}
            overlay={({ rects, bounds, frame }) => (
              <>
                {tool === "draw" ? <DrawLayer key={`${device}|${route}`} hostChat={bridge?.kind === "mcp"} frame={frame} sendLabel={sendLabel} busy={busy} onSend={sendDrawing} onExit={() => setTool("browse")} /> : null}
                {sel && tool === "text" && textEditing ? <TextHint rect={rects[sel.src]} bounds={bounds} /> : null}
                <CommentLayer comments={comments} rects={rects} bounds={bounds} draft={tool === "comment" ? sel : null} sendLabel={sendLabel}
                  onAdd={addComment} onCancel={clearSel} onDelete={(id) => setComments((cs) => cs.filter((c) => c.id !== id))}
                  onSend={sendComments} onClear={() => setComments([])} />
              </>
            )} />
          {tab === "preview" && bridge?.kind !== "mcp" && sel && tool === "select" && !textEditing ? (
            <Composer key={sel.src} sel={sel} sendLabel={sendLabel} busy={busy} onSend={sendPrompt} onClear={clearSel} onEscape={escapeTool} />
          ) : null}
        </div>
        {tab === "files" ? (
          <DownloadFiles project={project} title={st?.title} files={st?.files ?? []} sizes={st?.sizes ?? {}} touched={touched} query={queries.files}
            onDownload={(p) => void download(p)} onCopy={(p) => void copyFilePath(p)}
            onOpen={(p) => { setTab("code"); void openFile(p); }} />
        ) : null}
        {tab === "code" ? (
          <CodeWorkspace files={st?.files ?? []} sizes={st?.sizes ?? {}} file={file} draft={draft} dirty={dirty} dark={dark}
            touched={touched} reveal={reveal} conflict={conflict} saving={saving}
            live={live} liveActive={liveActive} streaming={streaming} query={queries.code} results={codeResults} searching={searching}
            onOpen={(p, line) => { if (streaming && live.some((f) => f.path === p)) setLiveActive(p); else void openFile(p, line); }}
            onChange={setDraft} onSave={() => void save()} onRevert={() => file && setDraft(file.content)}
            onLoadTheirs={() => file && void openFile(file.path)} onOverwrite={() => void save(true)}
            onCopy={() => void copyOpen()} onDownloadFile={() => file && void download(file.path)} />
        ) : null}
        {tab === "layers" ? (
          <LayersPanel query={queries.layers} call={call} project={project} filesKey={filesKey} env={docEnv}
            onOpenFile={(p, l) => { setTab("code"); void openFile(p, l); }} />
        ) : null}
        {docsSeen && bridge && project ? (
          <div className="pane" hidden={tab !== "docs"}>
            <DocsPane focus={view === "doc"} tool={tool} busy={busy} sendLabel={sendLabel} onExitTool={() => setTool("browse")} call={call} env={docEnv} query={queries.docs} refreshKey={docsRefresh} openReq={openDoc} onDirty={setDocsDirty} project={project} saveRef={docsSave} />
          </div>
        ) : null}
      </div>
      {tab === "preview" || tab === "docs" ? (
        <div className={`tools-dock pos-${toolPos === "auto" ? (bridge?.kind === "mcp" ? "top" : "bottom") : toolPos}`}>
          <FloatingToolbar tool={tool} setTool={(t) => { setTool(t); if (t === "browse") clearSel(); }} dock={dock} setDock={setDock}
            theme={themePref} setTheme={setThemePref} shortcuts={shortcuts} setShortcuts={setShortcuts} postSel={bridge?.kind === "mcp" ? postSel : undefined} setPostSel={setPostSel} pos={toolPos} setPos={setToolPos} />
        </div>
      ) : null}
      {toast ? <div className="toast" onClick={() => setToast(null)}>{toast}</div> : null}
    </div>
  );
}