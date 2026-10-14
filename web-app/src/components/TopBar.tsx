import { useState } from "react";
import type { RefObject } from "react";
import { Icon } from "./Icon";
import { ago } from "../util";
import type { Device, Route, Tab, VersionEntry } from "../types";

type Props = {
  view: "app" | "doc" | "all"; setView: (v: "app" | "doc" | "all") => void;
  tab: Tab; setTab: (t: Tab) => void;
  device: Device; setDevice: (d: Device) => void;
  routes: Route[]; route: string; setRoute: (r: string) => void;
  projects: string[]; project: string; setProject: (p: string) => void;
  building: boolean; onRefresh: () => void;
  canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void;
  versions: VersionEntry[]; onOpenVersions: () => void; onRestore: (keep: number) => void;
  docsDirty: boolean;
  onDownload: () => void; onOpenBrowser: () => void; canOpenBrowser: boolean;
  expanded: boolean; onExpand: () => void; onClose: () => void;
  search: { value: string; onChange: (v: string) => void; placeholder: string; summary: string }; searchRef: RefObject<HTMLInputElement | null>;
};

const DEVICE_ICON: Record<Device, string> = { desktop: "monitor", tablet: "tablet", mobile: "phone" };
const WHO: Record<string, string> = { ai: "AI", user: "You", visual: "Visual edit", undo: "Undo", redo: "Redo" };
const SHORT: Record<Tab, string> = { preview: "Preview", files: "Files", code: "Code", layers: "Layers", docs: "Docs" };
const shortOf = (t: Tab, view: string) => (view === "doc" ? "Preview" : SHORT[t]);

/** Every tab shows only the controls that make sense there (like Lovable): Preview = device, path, reload, open; Code = history; Files = download. */
export function TopBar(p: Props) {
  const [verOpen, setVerOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const all: { id: Tab; icon: string; label: string }[] = [
    { id: "preview", icon: "globe", label: "Preview" },
    { id: "files", icon: "file", label: "Files (download)" },
    { id: "code", icon: "code", label: "Code" },
    { id: "layers", icon: "layers", label: "Layers (elements, structure, diagrams)" },
    { id: "docs", icon: "doc", label: "Docs (documents, images, charts)" },
  ];
  // Only the tabs that belong to what the AI made: an app shows preview/code/files/layers, a document shows no tabs at all.
  const tabs = p.view === "doc" ? [{ id: "docs" as Tab, icon: "globe", label: "Preview" }] : all.filter((t) => p.view === "all" || t.id !== "docs");
  return (
    <div className="topbar">
      {p.view === "doc" ? (
        <button className="back" title="Back to the app" onClick={() => p.setView("app")}><Icon name="chevronl" size={15} /> App</button>
      ) : null}
      {tabs.length ? <div className="pills" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} title={t.label}
            className={`pill${p.tab === t.id ? " active" : ""}`} onClick={() => p.setTab(t.id)}>
            <Icon name={t.icon} size={16} />
            {p.tab === t.id ? <span>{shortOf(t.id, p.view)}</span> : null}
            {t.id === "docs" && p.docsDirty ? <i className="dot" title="Unsaved edits" /> : null}
          </button>
        ))}
      </div> : null}

      {p.view === "doc" ? <div className="center-tools" /> : p.tab === "preview" ? (
        <div className="center-tools preview-tools">
          <div className="menu-wrap">
            <button className={`icon-btn device-btn${devOpen ? " on" : ""}`} title="Device" aria-label="Device" aria-haspopup="menu" aria-expanded={devOpen} onClick={() => setDevOpen(!devOpen)}>
              <Icon name={DEVICE_ICON[p.device]} size={18} />
            </button>
            {devOpen ? (
              <div className="menu device-menu" role="menu" onMouseLeave={() => setDevOpen(false)}>
                {(["desktop", "tablet", "mobile"] as Device[]).map((d) => (
                  <button key={d} role="menuitem" className={`menu-item${p.device === d ? " on" : ""}`} onClick={() => { p.setDevice(d); setDevOpen(false); }}>
                    <Icon name={DEVICE_ICON[d]} size={16} /> {d[0].toUpperCase() + d.slice(1)}
                    {p.device === d ? <span className="tick"><Icon name="check" size={14} /></span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <label className="pathbar" title="Page">
            <button type="button" className={`icon-btn sm${p.building ? " spin" : ""}`} title="Reload preview" aria-label="Reload preview" onClick={(e) => { e.preventDefault(); p.onRefresh(); }}><Icon name="refresh" size={15} /></button>
            <select value={p.route} onChange={(e) => p.setRoute(e.target.value)} aria-label="Page">
              {p.routes.map((r) => <option key={r.path} value={r.path}>{r.path === "/" ? "/" : r.path}{r.label && r.path !== "/" ? `  ·  ${r.label}` : ""}</option>)}
            </select>
          </label>
          {p.canOpenBrowser ? <button className="icon-btn" title="Open preview in a new tab" onClick={p.onOpenBrowser}><Icon name="external" /></button> : null}
        </div>
      ) : (
        <div className="center-tools">
          <label className="searchbox">
            <Icon name="search" size={15} />
            <input ref={p.searchRef} type="search" aria-label="Search" placeholder={p.search.placeholder} value={p.search.value}
              onChange={(e) => p.search.onChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { p.search.onChange(""); (e.target as HTMLInputElement).blur(); } }} />
            {p.search.value ? <button type="button" className="icon-btn sm" title="Clear search" aria-label="Clear search" onClick={() => p.search.onChange("")}><Icon name="x" size={13} /></button> : null}
          </label>
          {p.search.summary ? <span className="muted search-summary">{p.search.summary}</span> : null}
        </div>
      )}

      <div className="right-tools">
        {p.view === "app" ? <button className="icon-btn" title="Documents, images and charts" onClick={() => { p.setView("all"); p.setTab("docs"); }}><Icon name="doc" /></button> : null}
        {p.view === "doc" ? <button className="icon-btn" title="All documents" onClick={() => p.setView("all")}><Icon name="layers" /></button> : null}
        {p.view === "all" ? <button className="icon-btn" title="Back to the app only" onClick={() => { p.setView("app"); }}><Icon name="x" /></button> : null}
        {p.tab === "code" && p.view !== "doc" ? (
          <>
            <button className="icon-btn" title="Undo" disabled={!p.canUndo} onClick={p.onUndo}><Icon name="undo" /></button>
            <button className="icon-btn" title="Redo" disabled={!p.canRedo} onClick={p.onRedo}><Icon name="redo" /></button>
            <div className="menu-wrap">
              <button className={`icon-btn${verOpen ? " on" : ""}`} title="Version history" onClick={() => { if (!verOpen) p.onOpenVersions(); setVerOpen(!verOpen); }}>
                <Icon name="history" />
              </button>
              {verOpen ? (
                <div className="menu versions" onMouseLeave={() => setVerOpen(false)}>
                  <div className="menu-title">VERSION HISTORY</div>
                  {p.versions.length === 0 ? <div className="empty small">No changes yet.</div> : p.versions.map((v, i) => (
                    <div key={v.index} className="version">
                      <div>
                        <div><b>{v.kind === "created" ? "Created" : v.kind === "deleted" ? "Deleted" : "Edited"}</b> {v.path}</div>
                        <div className="muted">{WHO[v.source] ?? v.source} · {ago(v.ts)}</div>
                      </div>
                      {i === 0 ? <span className="muted">Current</span>
                        : <button onClick={() => { setVerOpen(false); p.onRestore(v.index); }}>Restore</button>}
                    </div>
                  ))}
                  {p.versions.length > 0 ? (
                    <div className="version">
                      <div><b>Original</b><div className="muted">before any change in this session</div></div>
                      <button onClick={() => { setVerOpen(false); p.onRestore(0); }}>Restore</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {p.tab === "files" && p.view !== "doc" ? <button className="icon-btn" title="Download project (.zip)" onClick={p.onDownload}><Icon name="download" /></button> : null}
        <button className="icon-btn" title={p.expanded ? "Exit full screen" : "Expand"} aria-label={p.expanded ? "Exit full screen" : "Expand"} onClick={p.onExpand}>
          <Icon name={p.expanded ? "shrink" : "expand"} />
        </button>
        <button className="icon-btn" title="Collapse" onClick={p.onClose}><Icon name="x" /></button>
      </div>
    </div>
  );
}
