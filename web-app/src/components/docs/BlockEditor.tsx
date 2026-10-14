import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import { AskInline } from "../Diagram";
import { useHistory } from "../../lib/useHistory";
import { blobToBase64 } from "../../lib/svgdoc";
import type { Block, DocSelection, Run } from "../../types";
import type { EditorProps } from "./shared";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const uid = () => "n" + Math.random().toString(36).slice(2, 9);
const safeHref = (h: string) => /^(https?:|mailto:|#)/i.test(h);

export function runsToHtml(runs: Run[] = []): string {
  return runs.map((r) => {
    let h = esc(r.t).replace(/\n/g, "<br>");
    if (r.c) h = `<code>${h}</code>`;
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.href && safeHref(r.href)) h = `<a href="${esc(r.href)}">${h}</a>`;
    return h;
  }).join("");
}

export function htmlToRuns(root: HTMLElement): Run[] {
  const out: Run[] = [];
  const walk = (n: Node, st: { b?: boolean; i?: boolean; c?: boolean; href?: string }) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent ?? "";
      if (t) out.push({ t, ...(st.b ? { b: true } : {}), ...(st.i ? { i: true } : {}), ...(st.c ? { c: true } : {}), ...(st.href ? { href: st.href } : {}) });
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement, tag = el.tagName.toLowerCase();
    if (tag === "br") { out.push({ t: "\n", ...st }); return; }
    const next = { ...st };
    const w = el.style.fontWeight;
    if (tag === "b" || tag === "strong" || w === "bold" || Number(w) >= 600) next.b = true;
    if (tag === "i" || tag === "em" || el.style.fontStyle === "italic") next.i = true;
    if (tag === "code") next.c = true;
    if (tag === "a") { const h = el.getAttribute("href") ?? ""; if (safeHref(h)) next.href = h; }
    el.childNodes.forEach((c) => walk(c, next));
    if ((tag === "div" || tag === "p") && el !== root && el.nextSibling) out.push({ t: "\n" });
  };
  root.childNodes.forEach((c) => walk(c, {}));
  const merged: Run[] = [];
  for (const r of out) {
    const p = merged[merged.length - 1];
    if (p && !!p.b === !!r.b && !!p.i === !!r.i && !!p.c === !!r.c && p.href === r.href) p.t += r.t; else merged.push({ ...r });
  }
  return merged.length ? merged : [{ t: "" }];
}

const TYPES: { id: string; label: string }[] = [{ id: "p", label: "Paragraph" }, { id: "h1", label: "Heading 1" }, { id: "h2", label: "Heading 2" }, { id: "h3", label: "Heading 3" }, { id: "h4", label: "Heading 4" },
  { id: "li", label: "Bullet" }, { id: "oli", label: "Numbered" }, { id: "quote", label: "Quote" }, { id: "code", label: "Code" }];
const plain = (b: Block) => (b.runs ?? []).map((r) => r.t).join("");

/** One editable text block. The DOM is the source of truth while typing; it is read back into runs. */
function TextBlock({ b, active, readOnly, onFocus, onRuns, onSel }: { b: Block; active: boolean; readOnly: boolean; onFocus: () => void; onRuns: (r: Run[]) => void; onSel: (s: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => runsToHtml(b.runs), [b.runs]);
  useEffect(() => { const el = ref.current; if (el && el.innerHTML !== html) el.innerHTML = html; }, [html]);
  const Tag = (b.type.startsWith("h") ? b.type : "div") as "div";
  return (
    <Tag ref={ref as never} className={`blk ${b.type}${active ? " active" : ""}`} contentEditable={!readOnly && !b.locked} suppressContentEditableWarning spellCheck
      data-ph={b.type === "p" ? "Type something…" : ""}
      onFocus={onFocus}
      onInput={(e) => onRuns(htmlToRuns(e.currentTarget))}
      onBlur={(e) => onRuns(htmlToRuns(e.currentTarget))}
      onMouseUp={() => onSel(window.getSelection()?.toString() ?? "")} onKeyUp={() => onSel(window.getSelection()?.toString() ?? "")}
      onPaste={(e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain")); }} />
  );
}

/** docx and generated pdf: a page-like editor over the block model. Word files are edited in place, so styles and images survive. */
export function BlockEditor({ item, payload, onChange, env, readOnly }: EditorProps) {
  const blocks: Block[] = payload.blocks ?? [];
  const [cur, setCur] = useState<string | null>(null);
  const [selText, setSelText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (next: Block[]) => onChange({ ...payload, blocks: next });
  const hist = useHistory<Block[]>(blocks, set);
  useEffect(() => { hist.reset(); setCur(null); }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (fn: (b: Block[]) => void, key?: string) => { const c = structuredClone(blocks); fn(c); hist.commit(c, key); };
  const idx = blocks.findIndex((b) => b.id === cur);
  const isPdf = item.kind === "pdf";

  const selection = useMemo<DocSelection | null>(() => {
    const b = blocks[idx];
    if (!b) return null;
    const t = selText.trim();
    const label = t ? `selected text in ${b.type === "p" ? "paragraph" : b.type} ${idx + 1}` : `${b.type === "table" ? "table" : b.type === "image" ? "image" : b.type === "p" ? "paragraph" : b.type} ${idx + 1}`;
    return { docId: item.id, docName: item.name, kind: item.kind, label, text: t || plain(b) || (b.rows ? b.rows.map((r) => r.join("\t")).join("\n") : ""), detail: JSON.stringify({ blockId: b.id, ref: b.ref, type: b.type }) };
  }, [blocks, idx, selText, item]);
  useEffect(() => { env.onSelection(selection); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (cmd: string, val?: string) => { document.execCommand(cmd, false, val); };
  const addAfter = (nb: Block) => edit((b) => { b.splice(idx < 0 ? b.length : idx + 1, 0, nb); setCur(nb.id); });
  const setType = (type: string) => edit((b) => { if (b[idx]?.runs) b[idx].type = type; });
  const move = (d: number) => edit((b) => { const j = idx + d; if (idx < 0 || j < 0 || j >= b.length) return; [b[idx], b[j]] = [b[j], b[idx]]; });
  const remove = () => edit((b) => { if (idx >= 0) { b.splice(idx, 1); setCur(null); } });
  const link = () => { const u = prompt("Link address (https://…)"); if (u && safeHref(u)) fmt("createLink", u); else if (u) env.say("Only http(s), mailto and # links are allowed"); };
  const addImage = async (f: File) => {
    if (f.size > 1_400_000) { env.say("Images in documents are limited to about 1.4 MB. Shrink it first."); return; }
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) { env.say("Use a PNG, JPEG, GIF or WebP image."); return; }
    addAfter({ id: uid(), type: "image", src: `data:${f.type};base64,${await blobToBase64(f)}` });
  };

  return (
    <div className="blocks">
      <div className="dg-bar">
        <button className="icon-btn" title="Undo" disabled={!hist.canUndo} onClick={hist.undo}><Icon name="undo" size={16} /></button>
        <button className="icon-btn" title="Redo" disabled={!hist.canRedo} onClick={hist.redo}><Icon name="redo" size={16} /></button>
        {!readOnly ? (
          <>
            <select value={blocks[idx]?.runs ? blocks[idx].type : ""} disabled={!blocks[idx]?.runs} onChange={(e) => setType(e.target.value)} aria-label="Block style">
              {!blocks[idx]?.runs ? <option value="">Style</option> : null}{TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <button className="icon-btn" title="Bold (Ctrl+B)" onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("bold")}><Icon name="bold" size={16} /></button>
            <button className="icon-btn" title="Italic (Ctrl+I)" onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("italic")}><Icon name="italic" size={16} /></button>
            <button className="icon-btn" title="Link" onMouseDown={(e) => e.preventDefault()} onClick={link}><Icon name="link" size={16} /></button>
            <button className="icon-btn" title="Move up" onClick={() => move(-1)} disabled={idx <= 0}><span style={{ display: "inline-flex", transform: "rotate(-90deg)" }}><Icon name="chevron" size={16} /></span></button>
            <button className="icon-btn" title="Move down" onClick={() => move(1)} disabled={idx < 0 || idx >= blocks.length - 1}><span style={{ display: "inline-flex", transform: "rotate(90deg)" }}><Icon name="chevron" size={16} /></span></button>
            <span className="sep" />
            <button onClick={() => addAfter({ id: uid(), type: "p", runs: [{ t: "" }] })}><Icon name="plus" size={13} /> Paragraph</button>
            <button onClick={() => addAfter({ id: uid(), type: "table", rows: [["", "", ""], ["", "", ""]] })}><Icon name="table" size={13} /> Table</button>
            <button onClick={() => fileRef.current?.click()}><Icon name="image" size={13} /> Image</button>
            <button onClick={() => addAfter({ id: uid(), type: "hr" })}>―</button>
            <button className="danger" disabled={idx < 0} onClick={remove}><Icon name="trash" size={13} /></button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void addImage(f); e.target.value = ""; }} />
          </>
        ) : null}
        <span className="grow" />
        {isPdf ? <span className="chip" title="Saving rebuilds the PDF from these blocks">PDF · rebuilt on save</span> : null}
      </div>
      <div className="page-scroll">
        <article className="page">
          {blocks.length === 0 ? <p className="muted">This document is empty. Add a paragraph.</p> : null}
          {blocks.map((b, i) => {
            const on = b.id === cur;
            if (b.type === "hr") return <hr key={b.id} className={on ? "active" : ""} onClick={() => setCur(b.id)} />;
            if (b.type === "image") return (
              <figure key={b.id} className={`blk-img${on ? " active" : ""}`} onClick={() => setCur(b.id)}>
                {b.src ? <img src={b.src} alt="" /> : <div className="muted">Image (not stored inline: {b.locked ? "kept as in the original" : "missing"})</div>}
              </figure>);
            if (b.type === "table") return (
              <div key={b.id} className={`blk-table${on ? " active" : ""}`} onClick={() => setCur(b.id)}>
                <table><tbody>{(b.rows ?? []).map((r, ri) => (
                  <tr key={ri}>{r.map((c, ci) => (
                    <td key={ci}><input value={c} readOnly={readOnly} onFocus={() => setCur(b.id)} aria-label={`Row ${ri + 1} column ${ci + 1}`}
                      onChange={(e) => edit((x) => { x[i].rows![ri][ci] = e.target.value; }, `t${b.id}:${ri}:${ci}`)} /></td>))}</tr>))}</tbody></table>
                {on && !readOnly ? (
                  <div className="tbl-tools">
                    <button onClick={() => edit((x) => { x[i].rows!.push((x[i].rows![0] ?? [""]).map(() => "")); })}>+ row</button>
                    <button onClick={() => edit((x) => { x[i].rows!.forEach((r) => r.push("")); })}>+ column</button>
                    <button onClick={() => edit((x) => { if (x[i].rows!.length > 1) x[i].rows!.pop(); })}>− row</button>
                    <button onClick={() => edit((x) => { if (x[i].rows![0].length > 1) x[i].rows!.forEach((r) => r.pop()); })}>− column</button>
                  </div>) : null}
              </div>);
            return <TextBlock key={b.id} b={b} active={on} readOnly={readOnly} onFocus={() => setCur(b.id)} onSel={setSelText}
              onRuns={(runs) => { if (JSON.stringify(runs) !== JSON.stringify(b.runs)) edit((x) => { x[i].runs = runs; }, `b${b.id}`); }} />;
          })}
        </article>
      </div>
      <AskInline env={env} sel={selection} placeholder="Ask the AI to rewrite, shorten, translate or reformat the selected part…" />
    </div>
  );
}
