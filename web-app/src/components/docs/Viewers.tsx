import { useEffect, useMemo, useState } from "react";
import { AskInline } from "../Diagram";
import type { DocSelection } from "../../types";
import { dataUrl } from "./shared";
import type { EditorProps } from "./shared";

export function PdfView({ item, payload, env }: EditorProps) {
  const [mode, setMode] = useState<"text" | "pdf">("text");
  const [sel, setSel] = useState<DocSelection | null>(null);
  const pages: string[] = payload.text ?? [];
  const url = useMemo(() => {
    if (!payload.base64) return null;
    const bytes = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }, [payload.base64]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const onSel = () => {
    const s = window.getSelection()?.toString().trim();
    const n = s ? { docId: item.id, docName: item.name, kind: "pdf" as const, label: `selected PDF text “${s.slice(0, 40)}${s.length > 40 ? "…" : ""}”`, text: s } : null;
    setSel(n); env.onSelection(n);
  };
  return (
    <div className="pdfview">
      <div className="doc-subbar">
        <button className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>Text by page</button>
        <button className={mode === "pdf" ? "on" : ""} disabled={!url} onClick={() => setMode("pdf")}>Original PDF</button>
        <span className="muted small">{payload.pages ?? pages.length} pages · This PDF was uploaded, so it is view-only. Ask the AI for an editable copy (Convert → Word).</span>
      </div>
      {mode === "pdf" && url ? <embed className="pdf-embed" src={url} type="application/pdf" /> : (
        <div className="page-scroll" onMouseUp={onSel}>{pages.length ? pages.map((t, i) => <article key={i} className="page pdf-page"><div className="pg-n">Page {i + 1}</div><pre>{t || "(no text on this page)"}</pre></article>) : <div className="empty big">No text could be read from this PDF (it may be scanned images).</div>}</div>)}
      <AskInline env={env} sel={sel} placeholder="Ask the AI about this PDF, or to summarise the selected text…" />
    </div>
  );
}

export function MediaView({ item, payload }: EditorProps) {
  if (!payload.base64) return <div className="empty big">This file is too large to play here. Download it instead.</div>;
  const u = dataUrl(payload.mime, payload.base64);
  return <div className="media">{item.kind === "video" ? <video controls src={u} /> : <audio controls src={u} />}</div>;
}

export function GenericView({ item, payload }: EditorProps) {
  return (
    <div className="empty big generic">
      <b>{item.name}</b>
      <span>{payload.label ?? item.mime} · {(item.size / 1024).toFixed(1)} KB</span>
      <span className="muted">This type cannot be shown or edited here. Use Download.</span>
    </div>
  );
}

type NbCell = { type: string; source: string; outputs: (string | { png: string })[] };
/** A Jupyter notebook, read-only: markdown cells as text, code cells with their outputs (text and PNG). */
export function NotebookView({ payload }: EditorProps) {
  const cells: NbCell[] = payload.cells ?? [];
  return (
    <div className="page-scroll nb">
      <div className="page nb-page">
        {cells.length === 0 ? <div className="empty">This notebook has no cells.</div> : cells.map((c, i) => (
          <section key={i} className={`nb-cell ${c.type}`}>
            {c.type === "code" ? <><div className="nb-in"><span className="muted small">In [{i + 1}]</span><pre><code>{c.source}</code></pre></div>
              {c.outputs.map((o, k) => typeof o === "string" ? <pre key={k} className="nb-out">{o}</pre> : <img key={k} className="nb-img" alt="output" src={`data:image/png;base64,${o.png}`} />)}</>
              : <div className="nb-md">{c.source}</div>}
          </section>))}
      </div>
    </div>
  );
}

const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** The files inside a ZIP (names and sizes). */
export function ArchiveView({ item, payload }: EditorProps) {
  const entries: { name: string; size: number; dir: boolean }[] = payload.entries ?? [];
  return (
    <div className="page-scroll">
      <div className="page arc">
        <div className="muted small">{item.name} · {payload.count ?? entries.length} items{(payload.count ?? 0) > entries.length ? ` (first ${entries.length} shown)` : ""}</div>
        {entries.map((e) => <div key={e.name} className="arc-row"><span>{e.dir ? "📁" : "📄"} {e.name}</span><span className="muted small">{e.dir ? "" : sizeOf(e.size)}</span></div>)}
      </div>
    </div>
  );
}
