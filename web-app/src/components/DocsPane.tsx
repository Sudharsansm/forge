import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Icon } from "./Icon";
import { ChartEditor } from "./Chart";
import { DiagramEditor } from "./Diagram";
import { BlockEditor } from "./docs/BlockEditor";
import { ImageEditor } from "./docs/ImageEditor";
import { SheetGrid } from "./docs/SheetGrid";
import { SlidesEditor } from "./docs/SlidesEditor";
import { SvgEditor } from "./docs/SvgEditor";
import { TextDoc } from "./docs/TextDoc";
import { ArchiveView, GenericView, MediaView, NotebookView, PdfView } from "./docs/Viewers";
import type { Env } from "./docs/env";
import { ago } from "../util";
import { ItemLayer } from "./ItemLayer";
import type { ExportFile, LibItem, Tool } from "../types";

type Call = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
type Loaded = { item: LibItem; version: number; payload: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type VersionRow = { version: number; current: boolean; updated: number; size: number; source?: string | null };

const KIND_ICON: Record<string, string> = { docx: "doc", markdown: "doc", text: "doc", html: "code", json: "code", csv: "table", xlsx: "table", pptx: "slides", pdf: "doc", notebook: "doc", archive: "file", image: "image", svg: "image", chart: "chart", diagram: "diagram" };
const KIND_LABEL: Record<string, string> = { docx: "Word document", markdown: "Document", text: "Text", html: "HTML", json: "JSON", csv: "Table", xlsx: "Spreadsheet", pptx: "Presentation", pdf: "PDF", notebook: "Notebook", archive: "Archive", audio: "Audio", video: "Video", other: "File", image: "Image", svg: "Image", chart: "Chart", diagram: "Diagram" };
const KIND_TINT: Record<string, string> = { docx: "#2563eb", markdown: "#2563eb", text: "#64748b", html: "#ea580c", json: "#64748b", csv: "#16a34a", xlsx: "#16a34a", pptx: "#ea580c", pdf: "#dc2626", notebook: "#ea580c", archive: "#64748b", audio: "#9333ea", video: "#9333ea", image: "#9333ea", svg: "#9333ea", chart: "#0891b2", diagram: "#0891b2" };
const extOf = (name: string) => { const m = /\.([A-Za-z0-9]+)$/.exec(name); return m ? m[1].toUpperCase() : ""; };
const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Props = {
  /** Just the open document (the AI made it): no library list. */
  focus?: boolean;
  /** The preview tools (select, draw, comment) that work on whatever file is open. */
  tool?: Tool; busy?: boolean; sendLabel?: string; onExitTool?: () => void;
  call: Call; env: Env; query: string; refreshKey: number; openReq: { id: string; nonce: number } | null;
  onDirty: (d: boolean) => void; project: string;
  /** Lets the workbench save unsaved edits before it sends them to the AI. */
  saveRef: MutableRefObject<(() => Promise<boolean>) | null>;
};

export function DocsPane({ focus, tool, busy, sendLabel, onExitTool, call, env, query, refreshKey, openReq, onDirty, project, saveRef }: Props) {
  const [items, setItems] = useState<LibItem[]>([]);
  const [meta, setMeta] = useState<{ maxUploadMb: number; convertTo: string[]; stats?: { count: number; bytes: number } }>({ maxUploadMb: 15, convertTo: [] });
  const [openId, setOpenId] = useState<string | null>(null);
  const [doc, setDoc] = useState<Loaded | null>(null);
  const [payload, setPayload] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const [stamp, setStamp] = useState(0);
  const [menu, setMenu] = useState<"new" | "ver" | "conv" | "more" | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const editorHost = useRef<HTMLDivElement>(null);
  const live = useRef({ doc, payload, dirty });
  live.current = { doc, payload, dirty };

  const refresh = useCallback(async () => {
    try {
      const r = await call<{ items: LibItem[]; maxUploadMb: number; convertTo: string[]; stats: { count: number; bytes: number } }>("forge_ui_lib_list");
      setItems(r.items); setMeta({ maxUploadMb: r.maxUploadMb, convertTo: r.convertTo, stats: r.stats });
      return r.items;
    } catch (e) { env.say(errMsg(e)); return null; }
  }, [call, env]);

  const load = useCallback(async (id: string, version?: number) => {
    setLoading(true);
    try {
      const r = await call<Loaded>("forge_ui_lib_get", version ? { id, version } : { id });
      setDoc(r); setPayload(r.payload); setDirty(false); setConflict(null); setViewing(version && version !== r.item.version ? version : null); setStamp((s) => s + 1);
    } catch (e) { env.say(errMsg(e)); setDoc(null); setPayload(null); } finally { setLoading(false); }
  }, [call, env]);

  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { setOpenId(null); setDoc(null); setPayload(null); setDirty(false); void refresh(); }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async (opts: { force?: boolean } = {}): Promise<boolean> => {
    const { doc: d, payload: p, dirty: dd } = live.current;
    if (!d || !dd || viewing !== null) return true;
    setSaving(true);
    try {
      const r = await call<{ ok: boolean; item?: LibItem; conflict?: boolean; current_version?: number; error?: string }>("forge_ui_lib_save", { id: d.item.id, payload: p, base_version: opts.force ? null : d.version });
      if (r.ok && r.item) { setDoc({ item: r.item, version: r.item.version, payload: p }); setDirty(false); setConflict(null); void refresh(); return true; }
      if (r.conflict) setConflict(r.current_version ?? -1); else env.say(r.error ?? "Could not save");
      return false;
    } catch (e) { env.say(errMsg(e)); return false; } finally { setSaving(false); }
  }, [call, env, refresh, viewing]);

  // Like Claude's docs: no Save button, edits are saved a moment after you stop typing.
  useEffect(() => {
    if (!dirty || viewing !== null || conflict !== null) return;
    const t = window.setTimeout(() => void save(), 1200);
    return () => window.clearTimeout(t);
  }, [dirty, payload, viewing, conflict, save]);
  const [titleDraft, setTitleDraft] = useState("");
  useEffect(() => { setTitleDraft(doc?.item.name ?? ""); }, [doc?.item.id, doc?.item.name]);

  useEffect(() => { saveRef.current = () => save(); return () => { saveRef.current = null; }; }, [save, saveRef]);

  const open = useCallback(async (id: string) => {
    if (id === live.current.doc?.item.id) return;
    if (live.current.dirty && !(await save())) { env.say("Could not save your edits, so this document stays open."); return; }
    setOpenId(id); setMenu(null); await load(id);
  }, [load, save, env]);

  // The AI created or opened a document: show it.
  useEffect(() => { if (openReq) { void refresh().then(() => open(openReq.id)); } }, [openReq?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // The library changed elsewhere (AI edit, other tab): reload the list and the open document if it has no unsaved edits.
  useEffect(() => {
    if (refreshKey === 0) return;
    void refresh().then((list) => {
      const d = live.current.doc;
      if (!d || !list) return;
      const now = list.find((i) => i.id === d.item.id);
      if (!now) { setDoc(null); setPayload(null); setOpenId(null); return; }
      if (now.version !== d.item.version) { if (!live.current.dirty) void load(d.item.id); else setConflict(now.version); }
    });
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && live.current.doc) { e.preventDefault(); void save(); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [save]);
  useEffect(() => { // unsaved edits: do not lose them silently when the tab is left
    const h = (e: BeforeUnloadEvent) => { if (live.current.dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, []);
  useEffect(() => () => { if (live.current.dirty) void save(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => { try { return await fn(); } catch (e) { env.say(errMsg(e)); return undefined; } };
  const download = async (id?: string) => { const r = await act(() => call<ExportFile>("forge_ui_lib_export", id ? { id } : {})); if (r) { await act(() => env.download(r)); env.say("Download started"); } };
  const remove = async (it: LibItem) => {
    if (!confirm(`Delete “${it.name}”? Its version history is deleted too.`)) return;
    await act(() => call("forge_ui_lib_delete", { id: it.id }));
    if (doc?.item.id === it.id) { setDoc(null); setPayload(null); setOpenId(null); setDirty(false); }
    void refresh();
  };
  const rename = async (it: LibItem, name: string) => {
    setRenaming(null);
    if (!name.trim() || name === it.name) return;
    const r = await act(() => call<{ item: LibItem }>("forge_ui_lib_rename", { id: it.id, name: name.trim() }));
    if (r) { void refresh(); if (doc?.item.id === it.id) setDoc({ ...doc, item: r.item }); }
  };
  const openVersions = async () => {
    if (!doc) return;
    setMenu(menu === "ver" ? null : "ver");
    const r = await act(() => call<{ versions: VersionRow[] }>("forge_ui_lib_versions", { id: doc.item.id }));
    if (r) setVersions(r.versions);
  };
  const restore = async (v: number) => {
    if (!doc) return;
    if (live.current.dirty && !confirm("Restoring replaces your unsaved edits. Continue?")) return;
    setMenu(null);
    const r = await act(() => call("forge_ui_lib_versions", { id: doc.item.id, restore: v }));
    if (r) { await load(doc.item.id); void refresh(); env.say(`Restored version ${v} as a new version`); }
  };
  const convert = async (to: string) => {
    if (!doc) return;
    setMenu(null);
    if (live.current.dirty && !(await save())) return;
    const r = await act(() => call<{ ok: boolean; item: LibItem }>("forge_ui_lib_convert", { id: doc.item.id, to }));
    if (r?.ok) { await refresh(); await open(r.item.id); env.say(`Created ${r.item.name}`); }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.kind.includes(q));
  }, [items, query]);

  const readOnly = viewing !== null;
  const editorProps = doc && payload ? { item: doc.item, payload, env, readOnly, onChange: (p: unknown) => { setPayload(p); setDirty(true); } } : null;
  const k = doc?.item.kind;
  const converts = useMemo(() => {
    if (!k) return [] as string[];
    const all = meta.convertTo.filter((t) => ({ docx: "docx", pdf: "pdf", md: "markdown", markdown: "markdown", txt: "text", xlsx: "xlsx", csv: "csv" } as Record<string, string>)[t] !== k);
    if (k === "docx" || k === "markdown" || k === "text" || k === "pdf") return all.filter((t) => ["docx", "pdf", "md", "txt"].includes(t));
    if (k === "csv" || k === "xlsx") return all.filter((t) => ["xlsx", "csv"].includes(t));
    return [];
  }, [k, meta.convertTo]);

  const editor = () => {
    if (!editorProps || !k) return null;
    const key = `${doc!.item.id}:${stamp}`;
    switch (k) {
      case "text": case "markdown": case "html": case "json": return <TextDoc key={key} {...editorProps} />;
      case "csv": case "xlsx": return <SheetGrid key={key} {...editorProps} />;
      case "docx": return <BlockEditor key={key} {...editorProps} />;
      case "pdf": return payload.blocks ? <BlockEditor key={key} {...editorProps} /> : <PdfView key={key} {...editorProps} />;
      case "pptx": return <SlidesEditor key={key} {...editorProps} />;
      case "svg": return <SvgEditor key={key} {...editorProps} />;
      case "image": return <ImageEditor key={key} {...editorProps} />;
      case "chart": return <ChartEditor key={key} spec={payload.spec} onChange={(s) => { setPayload({ ...payload, spec: s }); setDirty(true); }} env={env} docId={doc!.item.id} docName={doc!.item.name} />;
      case "diagram": return <DiagramEditor key={key} spec={payload.spec} onChange={(s) => { setPayload({ ...payload, spec: s }); setDirty(true); }} env={env} docId={doc!.item.id} docName={doc!.item.name} readOnly={readOnly} />;
      case "notebook": return <NotebookView key={key} {...editorProps} />;
      case "archive": return <ArchiveView key={key} {...editorProps} />;
      case "audio": case "video": return <MediaView key={key} {...editorProps} />;
      default: return <GenericView key={key} {...editorProps} />;
    }
  };

  const back = async () => {
    if (live.current.dirty && !(await save())) { env.say("Could not save your edits, so this document stays open."); return; }
    setDoc(null); setPayload(null); setOpenId(null); setDirty(false); setMenu(null);
  };

  // Nothing open: show the files as cards, the way Claude shows what it made (type, name, size, Download). Click a card to preview it.
  if (!doc && !focus) {
    return (
      <div className="docs gallery">
        <div className="gallery-head"><b>Files</b><span className="muted small">{shown.length}{shown.length !== items.length ? ` of ${items.length}` : ""}</span><span className="grow" />
          <button className="export-btn" disabled={!items.length} onClick={() => void download()}><Icon name="download" size={14} /> Download all (.zip)</button></div>
        {loading ? <div className="empty big">Opening…</div> : shown.length === 0 ? (
          <div className="empty big"><div className="doc-welcome"><Icon name="doc" size={34} /><b>{items.length ? "No files match" : "No files yet"}</b>
            <span>{items.length ? "Try a different search." : "Ask Claude to write a document, a spreadsheet, a presentation, a PDF, an image, a chart or a diagram and it appears here."}</span></div></div>
        ) : (
          <div className="file-cards">
            {shown.map((it) => {
              const tint = KIND_TINT[it.kind] ?? "#64748b";
              return (
                <div key={it.id} className="file-card" role="button" tabIndex={0} title={`Open ${it.name}`} onClick={() => void open(it.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") void open(it.id); }}>
                  <span className="ftile big" style={{ color: tint, background: tint + "1a" }}><Icon name={KIND_ICON[it.kind] ?? "file"} size={22} /></span>
                  <div className="meta">
                    {renaming === it.id ? <input autoFocus defaultValue={it.name} onClick={(e) => e.stopPropagation()} onBlur={(e) => void rename(it, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }} /> : <div className="nm">{it.name}</div>}
                    <div className="muted small">{[KIND_LABEL[it.kind] ?? it.kind, extOf(it.name) && extOf(it.name) !== (KIND_LABEL[it.kind] ?? "").toUpperCase() ? extOf(it.name) : "", sizeOf(it.size)].filter(Boolean).join(" · ")}</div>
                  </div>
                  <button className="dl-btn" title="Download" onClick={(e) => { e.stopPropagation(); void download(it.id); }}><Icon name="download" size={14} /> Download</button>
                  <button className="icon-btn sm hov" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(it.id); }}><Icon name="pencil" size={13} /></button>
                  <button className="icon-btn sm hov" title="Delete" onClick={(e) => { e.stopPropagation(); void remove(it); }}><Icon name="trash" size={13} /></button>
                </div>);
            })}
          </div>)}
      </div>
    );
  }

  return (
    <div className={`docs${focus ? " focus" : ""}`}>
      <aside className="doc-list">
        <div className="files-head">
          <b>Files</b>
          <span className="muted small">{items.length}</span>
          <span className="grow" />
          <button className="icon-btn sm" title="Download everything (.zip)" disabled={!items.length} onClick={() => void download()}><Icon name="download" size={15} /></button>
        </div>
        <div className="doc-items">
          {shown.length === 0 ? <div className="empty small">{items.length ? "No documents match." : "No files yet. Ask Claude to write a document, make an image, a chart or a diagram and it shows up here."}</div> : null}
          {shown.map((it) => (
            <div key={it.id} className={`doc-item${doc?.item.id === it.id || openId === it.id ? " on" : ""}`} onClick={() => void open(it.id)} title={it.name}>
              <span className="ftile" style={{ color: KIND_TINT[it.kind] ?? "#64748b", background: (KIND_TINT[it.kind] ?? "#64748b") + "1a" }}><Icon name={KIND_ICON[it.kind] ?? "file"} size={17} /></span>
              <div className="meta">
                {renaming === it.id ? <input autoFocus defaultValue={it.name} onClick={(e) => e.stopPropagation()} onBlur={(e) => void rename(it, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }} /> : <div className="nm">{it.name}</div>}
                <div className="muted small">{KIND_LABEL[it.kind] ?? it.kind} · {ago(it.updated)}{it.version > 1 ? ` · v${it.version}` : ""}</div>
              </div>
              <button className="icon-btn sm" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(it.id); }}><Icon name="pencil" size={13} /></button>
              <button className="icon-btn sm" title="Delete" onClick={(e) => { e.stopPropagation(); void remove(it); }}><Icon name="trash" size={13} /></button>
            </div>))}
        </div>
        {meta.stats ? <div className="muted small doc-foot">{meta.stats.count} documents · {(meta.stats.bytes / 1e6).toFixed(1)} MB</div> : null}
      </aside>
      <section className="doc-view">
        {!doc ? (
          <div className="empty big">{loading ? "Opening…" : (<div className="doc-welcome"><Icon name="doc" size={34} /><b>Documents</b><span>Pick a file on the left. Everything here can be viewed and edited. Select part of a file and ask Claude to change just that.</span></div>)}</div>
        ) : (
          <>
            <header className="doc-head">
              {focus ? null : <button className="back" title="Back to all files" onClick={() => void back()}><Icon name="chevronl" size={15} /> Files</button>}
              <Icon name={KIND_ICON[doc.item.kind] ?? "file"} size={17} />
              <input className="doc-title" aria-label="Document title" value={titleDraft} readOnly={readOnly} spellCheck={false}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => { if (titleDraft.trim() && titleDraft !== doc.item.name) void rename(doc.item, titleDraft); else setTitleDraft(doc.item.name); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setTitleDraft(doc.item.name); (e.target as HTMLInputElement).blur(); } }} />
              <span className="doc-status muted small" aria-live="polite">{viewing !== null ? `Viewing v${viewing}` : saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
              <span className="grow" />
              <div className="menu-wrap">
                <button className="icon-btn" title="Document versions" onClick={() => void openVersions()}><Icon name="history" size={16} /></button>
                {menu === "ver" ? <div className="menu versions" onMouseLeave={() => setMenu(null)}><div className="menu-title">VERSIONS</div>{versions.map((v) => (
                  <div key={v.version} className="version"><div><b>v{v.version}</b> {v.current ? "(current)" : ""}<div className="muted">{v.source ?? "?"} · {ago(v.updated)}</div></div>
                    {v.current ? null : <span className="row"><button onClick={() => { setMenu(null); void load(doc.item.id, v.version); }}>View</button><button onClick={() => void restore(v.version)}>Restore</button></span>}</div>))}</div> : null}
              </div>
              <div className="menu-wrap">
                <button className="export-btn" aria-haspopup="menu" onClick={() => setMenu(menu === "conv" ? null : "conv")}><Icon name="download" size={14} /> Export <Icon name="chevron" size={12} /></button>
                {menu === "conv" ? (
                  <div className="menu small right export-menu" role="menu" onMouseLeave={() => setMenu(null)}>
                    <button role="menuitem" className="menu-item" onClick={() => { setMenu(null); void download(doc.item.id); }}><Icon name="download" size={15} /> Download</button>
                    {converts.map((t) => <button key={t} role="menuitem" className="menu-item" onClick={() => void convert(t)}><Icon name="convert" size={15} /> Convert to .{t}</button>)}
                  </div>) : null}
              </div>
            </header>
            {readOnly ? <div className="banner info">Viewing an older version (v{viewing}). <button onClick={() => void restore(viewing!)}>Restore this version</button><button onClick={() => void load(doc.item.id)}>Back to current</button></div> : null}
            {conflict !== null ? <div className="banner warn"><Icon name="warn" size={14} /> This document changed elsewhere{conflict > 0 ? ` (now v${conflict})` : ""} while you were editing.
              <button onClick={() => void load(doc.item.id)}>Load the latest (discard mine)</button><button onClick={() => void save({ force: true })}>Overwrite with mine</button></div> : null}
            <div ref={editorHost} className={`doc-editor kind-${doc.item.kind}`}>
              {editor()}
              {tool ? <ItemLayer host={editorHost} tool={tool} env={env} doc={{ id: doc.item.id, name: doc.item.name, kind: doc.item.kind }} project={project} sendLabel={sendLabel ?? "Send"} busy={Boolean(busy)} onExit={onExitTool ?? (() => undefined)} /> : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
