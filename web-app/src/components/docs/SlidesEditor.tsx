import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import { AskInline } from "../Diagram";
import { useHistory } from "../../lib/useHistory";
import type { DocSelection, Slide, SlideShape } from "../../types";
import type { EditorProps } from "./shared";

const label = (s: Slide, i: number) => s.shapes.find((x) => x.kind === "text" && x.text)?.text?.split("\n")[0]?.slice(0, 40) || s.title || `Slide ${i + 1}`;

/** pptx: slide list, a 16:9 canvas where text and table cells are edited in place, speaker notes, add / delete / reorder slides. */
export function SlidesEditor({ item, payload, onChange, env, readOnly }: EditorProps) {
  const slides: Slide[] = payload.slides ?? [];
  const [si, setSi] = useState(0);
  const [shapeId, setShapeId] = useState<number | null>(null);
  const [selText, setSelText] = useState("");
  const set = (next: Slide[]) => onChange({ ...payload, slides: next });
  const hist = useHistory<Slide[]>(slides, set);
  const cur = slides[Math.min(si, slides.length - 1)];
  const ratio: number = payload.ratio || 16 / 9;
  useEffect(() => { hist.reset(); setSi(0); setShapeId(null); }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (fn: (s: Slide[]) => void, key?: string) => { const c = structuredClone(slides); fn(c); hist.commit(c, key); };
  const stage = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => { const el = stage.current; if (!el) return; const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); return () => ro.disconnect(); }, []);

  const shape = cur?.shapes.find((s) => s.id === shapeId);
  const selection = useMemo<DocSelection | null>(() => {
    if (!cur) return null;
    const t = selText.trim();
    return { docId: item.id, docName: item.name, kind: "pptx", label: shape ? `${t ? "selected text in " : ""}${shape.name} on slide ${si + 1}` : `slide ${si + 1}`,
      text: t || shape?.text || cur.shapes.map((s) => s.text ?? "").filter(Boolean).join("\n"), detail: JSON.stringify({ slide: si, shape: shape?.id }) };
  }, [cur, shape, si, selText, item]);
  useEffect(() => { env.onSelection(selection); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cur) {
    return <div className="empty big">No slides. {!readOnly ? <button className="primary" onClick={() => edit((s) => { s.push({ shapes: [], notes: "", layout: "title", title: "Title", subtitle: "" }); })}>Add a slide</button> : null}</div>;
  }
  const fs = (sh: SlideShape) => Math.max(8, Math.min(40, (sh.fontPt ?? 18) * (w / 960)));
  const setShape = (sid: number, fn: (x: SlideShape) => void, key?: string) => edit((s) => { const t = s[si].shapes.find((x) => x.id === sid); if (t) fn(t); }, key);
  return (
    <div className="slides">
      <div className="dg-bar">
        <button className="icon-btn" title="Undo" disabled={!hist.canUndo} onClick={hist.undo}><Icon name="undo" size={16} /></button>
        <button className="icon-btn" title="Redo" disabled={!hist.canRedo} onClick={hist.redo}><Icon name="redo" size={16} /></button>
        {!readOnly ? <>
          <button onClick={() => { edit((s) => { s.splice(si + 1, 0, { shapes: [], notes: "", title: "New slide", bullets: ["First point"] }); }); setSi(si + 1); }}><Icon name="plus" size={13} /> Slide</button>
          <button className="icon-btn" title="Move slide up" disabled={si === 0} onClick={() => { edit((s) => { [s[si - 1], s[si]] = [s[si], s[si - 1]]; }); setSi(si - 1); }}><span style={{ display: "inline-flex", transform: "rotate(-90deg)" }}><Icon name="chevron" size={16} /></span></button>
          <button className="icon-btn" title="Move slide down" disabled={si >= slides.length - 1} onClick={() => { edit((s) => { [s[si + 1], s[si]] = [s[si], s[si + 1]]; }); setSi(si + 1); }}><span style={{ display: "inline-flex", transform: "rotate(90deg)" }}><Icon name="chevron" size={16} /></span></button>
          <button className="danger" disabled={slides.length < 2} onClick={() => { edit((s) => { s.splice(si, 1); }); setSi(Math.max(0, si - 1)); }}><Icon name="trash" size={13} /> Slide</button></> : null}
        <span className="grow" /><span className="muted small">{si + 1} / {slides.length}</span>
      </div>
      <div className="slides-main">
        <div className="thumbs">{slides.map((s, i) => (
          <button key={i} className={i === si ? "on" : ""} onClick={() => { setSi(i); setShapeId(null); }}><span className="n">{i + 1}</span><span className="t">{label(s, i)}</span></button>))}
        </div>
        <div className="stage-col">
          <div className="slide-stage" ref={stage} style={{ aspectRatio: String(ratio) }}>
            {cur.shapes.length === 0 ? <div className="muted slide-new">New slide: “{cur.title}”{cur.bullets?.length ? ` · ${cur.bullets.length} bullets` : ""}. Save to build it, then edit its text here.</div> : null}
            {cur.shapes.map((sh) => {
              const pos = { left: `${sh.x * 100}%`, top: `${sh.y * 100}%`, width: `${sh.w * 100}%`, height: `${sh.h * 100}%` };
              const on = sh.id === shapeId;
              if (sh.kind === "text") return (
                <div key={sh.id} className={`shape text${on ? " on" : ""}`} style={{ ...pos, fontSize: fs(sh) }} contentEditable={!readOnly} suppressContentEditableWarning
                  ref={(el) => { if (el && el !== document.activeElement && el.innerText !== (sh.text ?? "")) el.innerText = sh.text ?? ""; }}
                  onFocus={() => setShapeId(sh.id)} onInput={(e) => { const t = e.currentTarget.innerText; setShape(sh.id, (x) => { x.text = t; }, `s${si}:${sh.id}`); }}
                  onMouseUp={() => setSelText(window.getSelection()?.toString() ?? "")} onKeyUp={() => setSelText(window.getSelection()?.toString() ?? "")} />);
              if (sh.kind === "table") return (
                <div key={sh.id} className={`shape table${on ? " on" : ""}`} style={pos} onClick={() => setShapeId(sh.id)}>
                  <table><tbody>{(sh.rows ?? []).map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}><input value={c} readOnly={readOnly} style={{ fontSize: fs(sh) * 0.8 }} onFocus={() => setShapeId(sh.id)} onChange={(e) => setShape(sh.id, (x) => { x.rows![ri][ci] = e.target.value; }, `c${sh.id}:${ri}:${ci}`)} /></td>)}</tr>)}</tbody></table>
                </div>);
              if (sh.kind === "picture") return <div key={sh.id} className={`shape pic${on ? " on" : ""}`} style={pos} onClick={() => { setShapeId(sh.id); }}>{sh.src ? <img src={sh.src} alt="" /> : <span className="muted small">picture</span>}</div>;
              return <div key={sh.id} className={`shape other${on ? " on" : ""}`} style={pos} onClick={() => setShapeId(sh.id)} title={sh.name} />;
            })}
          </div>
          <label className="notes">Speaker notes
            <textarea value={cur.notes ?? ""} readOnly={readOnly} rows={3} onChange={(e) => edit((s) => { s[si].notes = e.target.value; }, `n${si}`)} /></label>
        </div>
      </div>
      <AskInline env={env} sel={selection} placeholder="Ask the AI to rewrite this slide, shorten the text, or add a slide…" />
    </div>
  );
}
