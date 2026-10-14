import { useMemo, useState } from "react";
import { CodeEditor } from "../CodeEditor";
import { AskInline } from "../Diagram";
import { mdToHtml } from "../../lib/md";
import type { DocSelection } from "../../types";
import type { EditorProps } from "./shared";

const LANG: Record<string, string> = { markdown: "markdown", html: "html", json: "json", text: "text", csv: "text" };

/** md / txt / html / json: CodeMirror plus a live preview. HTML previews run in a sandbox with no scripts. */
export function TextDoc({ item, payload, onChange, env, readOnly }: EditorProps) {
  const [mode, setMode] = useState<"split" | "edit" | "preview">(item.kind === "markdown" || item.kind === "html" ? "preview" : "edit");
  const [sel, setSel] = useState<DocSelection | null>(null);
  const text: string = payload.text ?? "";
  const canPreview = item.kind === "markdown" || item.kind === "html";
  const html = useMemo(() => (item.kind === "markdown" ? mdToHtml(text) : ""), [item.kind, text]);
  const fg = env.dark ? "#ececea" : "#1a1a19", bg = env.dark ? "#1f1f1e" : "#ffffff", soft = env.dark ? "#2b2b29" : "#f4f4f5", line = env.dark ? "#4a4a47" : "#d4d4d8";
  // a clean reading page, like Claude's docs: one centred column, roomy margins, light headings
  const css = `html{background:${bg}}body{font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;max-width:720px;margin:0 auto;padding:48px 28px 96px;color:${fg};background:${bg}}h1{font-size:32px;line-height:1.25;margin:0 0 20px;font-weight:650}h2{font-size:23px;margin:32px 0 10px;font-weight:650}h3{font-size:18px;margin:24px 0 8px;font-weight:650}p,li{margin:0 0 12px}img{max-width:100%;border-radius:8px}pre{background:${soft};padding:14px 16px;border-radius:10px;overflow:auto;font-size:13.5px}code{background:${soft};padding:1px 5px;border-radius:5px;font-size:.92em}pre code{background:none;padding:0}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid ${line};padding:6px 10px;text-align:left}blockquote{border-left:3px solid ${line};margin:12px 0;padding-left:16px;color:${env.dark ? "#a3a3a0" : "#555"}}a{color:#2563eb}hr{border:0;border-top:1px solid ${line};margin:28px 0}`;
  const srcDoc = item.kind === "html" ? text : `<!doctype html><meta charset="utf-8"><style>${css}</style>${html}`;
  const onSel = () => {
    const s = window.getSelection()?.toString().trim();
    const next = s ? { docId: item.id, docName: item.name, kind: item.kind, label: `“${s.length > 40 ? s.slice(0, 40) + "…" : s}”`, text: s } : null;
    setSel(next); env.onSelection(next);
  };
  return (
    <div className="textdoc">
      {canPreview ? (
        <div className="doc-subbar">
          {(["preview", "split"] as const).map((m) => <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{m === "preview" ? "Preview" : "Edit"}</button>)}
          {item.kind === "html" ? <span className="muted small">Preview runs without scripts.</span> : null}
        </div>
      ) : null}
      <div className={`td-body ${mode}`} onMouseUp={onSel} onKeyUp={onSel}>
        {mode !== "preview" ? (
          <div className="td-edit"><CodeEditor docKey={item.id} value={text} language={LANG[item.kind] ?? "text"} dark={env.dark} readOnly={readOnly}
            onChange={(v) => onChange({ ...payload, text: v })} onSave={() => undefined} /></div>
        ) : null}
        {mode !== "edit" && canPreview ? (item.kind === "markdown"
          ? <div className="td-preview md-preview" aria-label="Preview"><article className="md-page" dangerouslySetInnerHTML={{ __html: html }} /></div> /* mdToHtml escapes all HTML, so this is safe, and parts of it can be selected */
          : <iframe className="td-preview" title="Preview" sandbox="" srcDoc={srcDoc} />) : null}
      </div>
      {payload.valid === false ? <div className="banner warn">Invalid JSON: {payload.error}</div> : null}
      <AskInline env={env} sel={sel} placeholder="Ask the AI to rewrite the selected text, or the whole document…" />
    </div>
  );
}
