import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import { AskInline } from "../Diagram";
import { CodeEditor } from "../CodeEditor";
import { useHistory } from "../../lib/useHistory";
import { parseSvg, saveBlob, serializeSvg, svgToPng } from "../../lib/svgdoc";
import type { DocSelection } from "../../types";
import type { EditorProps } from "./shared";

const NS = "http://www.w3.org/2000/svg";
const SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "image", "g", "use"]);
const hexOf = (v: string | null): string => { if (!v || v === "none") return "#000000"; if (/^#[0-9a-f]{6}$/i.test(v)) return v; if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join(""); return "#000000"; };
const walk = (root: Element, path: number[]): Element | null => { let el: Element | null = root; for (const i of path) { el = el?.children[i] ?? null; } return el; };

/** svg: click an element to select it; move it, recolour it, edit its text, add shapes, or edit the source. Scripts and external links are stripped. */
export function SvgEditor({ item, payload, onChange, env, readOnly }: EditorProps) {
  const text: string = payload.text ?? "";
  const [path, setPath] = useState<number[] | null>(null);
  const [src, setSrc] = useState(false);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; k: number; moved: boolean } | null>(null);
  const set = (t: string) => onChange({ ...payload, text: t });
  const hist = useHistory<string>(text, set);
  useEffect(() => { hist.reset(); setPath(null); }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const root = useMemo(() => parseSvg(text), [text]);
  const markup = useMemo(() => (root ? serializeSvg(root) : ""), [root]);
  const mutate = (fn: (svg: SVGSVGElement, el: Element | null) => void, key?: string) => {
    const r = parseSvg(text); if (!r) return;
    fn(r, path ? walk(r, path) : null);
    hist.commit(serializeSvg(r), key);
  };
  const svgEl = () => host.current?.querySelector(".svg-host > svg") ?? null;
  const live = () => { const sv = svgEl(); return path && sv ? walk(sv, path) : null; };

  const measure = () => {
    const el = live(), h = host.current;
    if (!el || !h) { setBox(null); return; }
    const a = (el as SVGGraphicsElement).getBoundingClientRect(), b = h.getBoundingClientRect();
    setBox({ x: a.left - b.left + h.scrollLeft, y: a.top - b.top + h.scrollTop, w: a.width, h: a.height });
  };
  useEffect(measure, [path, markup, src]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const ro = new ResizeObserver(measure); if (host.current) ro.observe(host.current); return () => ro.disconnect(); }); // eslint-disable-line react-hooks/exhaustive-deps

  const pathTo = (target: Element): number[] | null => {
    const svg = svgEl(); if (!svg) return null;
    const out: number[] = [];
    let el: Element | null = target;
    while (el && el !== svg) { const p: Element | null = el.parentElement; if (!p) return null; out.unshift([...p.children].indexOf(el)); el = p; }
    return el === svg ? out : null;
  };
  const pick = (e: React.PointerEvent) => {
    let t = e.target as Element | null;
    while (t && t !== svgEl() && !SHAPES.has(t.tagName.toLowerCase())) t = t.parentElement;
    const p = t && t !== svgEl() ? pathTo(t) : null;
    setPath(p);
    if (p && !readOnly && t) {
      const svg = svgEl() as unknown as SVGSVGElement;
      const k = svg.getScreenCTM()?.a ?? 1;
      const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(t.getAttribute("transform") ?? "");
      drag.current = { x: e.clientX, y: e.clientY, tx: m ? +m[1] : 0, ty: m ? +m[2] : 0, k, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current, el = live(); if (!d || !el) return;
    const dx = (e.clientX - d.x) / d.k, dy = (e.clientY - d.y) / d.k;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3 / d.k) return;
    d.moved = true;
    const base = (el.getAttribute("transform") ?? "").replace(/translate\([^)]*\)\s*/, "");
    el.setAttribute("transform", `translate(${+(d.tx + dx).toFixed(2)} ${+(d.ty + dy).toFixed(2)}) ${base}`.trim());
    measure();
  };
  const endDrag = () => {
    const d = drag.current, el = live(); drag.current = null;
    if (!d?.moved || !el) return;
    const tr = el.getAttribute("transform") ?? "";
    mutate((_, t) => { if (t) t.setAttribute("transform", tr); });
  };

  const el0 = root && path ? walk(root, path) : null;
  const tag = el0?.tagName.toLowerCase() ?? "";
  const attr = (n: string) => el0?.getAttribute(n) ?? "";
  const setAttr = (n: string, v: string | null, key?: string) => mutate((_, t) => { if (!t) return; if (v === null || v === "") t.removeAttribute(n); else t.setAttribute(n, v); }, key ? `${key}${path?.join(".")}` : undefined);
  const view = root?.viewBox.baseVal;
  const vb = view && view.width ? view : { x: 0, y: 0, width: 400, height: 240 };
  const add = (kind: "rect" | "circle" | "text" | "line") => mutate((svg) => {
    const e = document.createElementNS(NS, kind);
    const cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2;
    if (kind === "rect") { e.setAttribute("x", String(cx - 50)); e.setAttribute("y", String(cy - 30)); e.setAttribute("width", "100"); e.setAttribute("height", "60"); e.setAttribute("rx", "8"); e.setAttribute("fill", "#2563eb"); }
    if (kind === "circle") { e.setAttribute("cx", String(cx)); e.setAttribute("cy", String(cy)); e.setAttribute("r", "36"); e.setAttribute("fill", "#f59e0b"); }
    if (kind === "text") { e.setAttribute("x", String(cx)); e.setAttribute("y", String(cy)); e.setAttribute("text-anchor", "middle"); e.setAttribute("font-size", "20"); e.setAttribute("fill", "#111827"); e.textContent = "Text"; }
    if (kind === "line") { e.setAttribute("x1", String(cx - 60)); e.setAttribute("y1", String(cy)); e.setAttribute("x2", String(cx + 60)); e.setAttribute("y2", String(cy)); e.setAttribute("stroke", "#111827"); e.setAttribute("stroke-width", "3"); }
    svg.appendChild(e);
    setPath([svg.children.length - 1]);
  });
  const remove = () => mutate((_, t) => { t?.remove(); setPath(null); });
  const dup = () => mutate((svg, t) => { if (!t?.parentElement) return; const c = t.cloneNode(true) as Element; const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(c.getAttribute("transform") ?? ""); c.setAttribute("transform", `translate(${(m ? +m[1] : 0) + 16} ${(m ? +m[2] : 0) + 16})`); t.parentElement.appendChild(c); setPath([...(path ?? []).slice(0, -1), t.parentElement.children.length - 1]); void svg; });
  const order = (front: boolean) => mutate((_, t) => { const p = t?.parentElement; if (!t || !p) return; if (front) p.appendChild(t); else p.insertBefore(t, p.firstElementChild); setPath([...(path ?? []).slice(0, -1), front ? p.children.length - 1 : 0]); });

  const selection = useMemo<DocSelection | null>(() => el0 ? ({ docId: item.id, docName: item.name, kind: "svg", label: `the <${tag}> element${el0.textContent && tag === "text" ? ` “${el0.textContent}”` : ""}`, detail: new XMLSerializer().serializeToString(el0).slice(0, 600) }) : null, [el0, tag, item]);
  useEffect(() => { env.onSelection(selection); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select,.cm-editor,[contenteditable=true]") || readOnly || src) return;
      if ((e.key === "Delete" || e.key === "Backspace") && path) { e.preventDefault(); remove(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) hist.redo(); else hist.undo(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });

  const exportPng = async () => {
    if (!root) return;
    const w = vb.width, h = vb.height, s = serializeSvg(root);
    try { await saveBlob(env.download, await svgToPng(s.replace(/<svg /, `<svg width="${w}" height="${h}" `), w, h, 2, "#ffffff"), item.name.replace(/\.svg$/i, "") + ".png"); env.say("Exported PNG"); } catch (e) { env.say(e instanceof Error ? e.message : String(e)); }
  };

  if (!root && !src) return <div className="empty big">This SVG could not be read safely. <button onClick={() => setSrc(true)}>Edit the source</button></div>;
  return (
    <div className="svged">
      <div className="dg-bar">
        <button className="icon-btn" title="Undo" disabled={!hist.canUndo} onClick={hist.undo}><Icon name="undo" size={16} /></button>
        <button className="icon-btn" title="Redo" disabled={!hist.canRedo} onClick={hist.redo}><Icon name="redo" size={16} /></button>
        {!readOnly && !src ? <>
          <button onClick={() => add("rect")}>▭ Rectangle</button><button onClick={() => add("circle")}>○ Circle</button><button onClick={() => add("line")}>╱ Line</button><button onClick={() => add("text")}><Icon name="type" size={13} /> Text</button>
          <button disabled={!path} onClick={dup}><Icon name="copy" size={13} /> Duplicate</button>
          <button disabled={!path} onClick={() => order(true)}>To front</button><button disabled={!path} onClick={() => order(false)}>To back</button>
          <button className="danger" disabled={!path} onClick={remove}><Icon name="trash" size={13} /></button></> : null}
        <span className="grow" />
        <button className={src ? "on" : ""} onClick={() => setSrc(!src)}><Icon name="code" size={14} /> Source</button>
        <button onClick={() => void exportPng()}><Icon name="download" size={14} /> PNG</button>
      </div>
      <div className="svg-main">
        {src ? <div className="svg-src"><CodeEditor docKey={item.id + ":src"} value={text} language="html" dark={env.dark} readOnly={readOnly} onChange={(v) => set(v)} onSave={() => undefined} /></div> : (
          <div className="svg-canvas" ref={host} onPointerDown={pick} onPointerMove={moveDrag} onPointerUp={endDrag} onScroll={measure}>
            <div className="svg-host" dangerouslySetInnerHTML={{ __html: markup }} />
            {box ? <div className="sel-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} /> : null}
          </div>)}
        {!src ? (
          <aside className="dg-side">
            <h4>{el0 ? `<${tag}>` : "Nothing selected"}</h4>
            {!el0 ? <div className="muted small">Click a shape or text to edit it. Drag to move it.</div> : null}
            {el0 && tag === "text" ? <label>Text<input value={el0.textContent ?? ""} readOnly={readOnly} onChange={(e) => mutate((_, t) => { if (t) t.textContent = e.target.value; }, `txt${path?.join(".")}`)} /></label> : null}
            {el0 && tag !== "g" && tag !== "image" ? <label>Fill<span className="row"><input type="color" value={hexOf(attr("fill"))} onChange={(e) => setAttr("fill", e.target.value, "fill")} /><button className="link-btn" onClick={() => setAttr("fill", "none")}>none</button></span></label> : null}
            {el0 && tag !== "g" && tag !== "image" && tag !== "text" ? <>
              <label>Stroke<span className="row"><input type="color" value={hexOf(attr("stroke"))} onChange={(e) => setAttr("stroke", e.target.value, "stroke")} /><button className="link-btn" onClick={() => setAttr("stroke", null)}>none</button></span></label>
              <label>Stroke width<input type="number" min="0" step="0.5" value={attr("stroke-width") || "0"} onChange={(e) => setAttr("stroke-width", e.target.value, "sw")} /></label></> : null}
            {el0 && tag === "text" ? <label>Font size<input type="number" min="4" value={attr("font-size") || "16"} onChange={(e) => setAttr("font-size", e.target.value, "fs")} /></label> : null}
            {el0 && tag === "rect" ? <label>Corner radius<input type="number" min="0" value={attr("rx") || "0"} onChange={(e) => { setAttr("rx", e.target.value, "rx"); }} /></label> : null}
            {el0 ? <label>Opacity<input type="range" min="0" max="1" step="0.05" value={attr("opacity") || "1"} onChange={(e) => setAttr("opacity", e.target.value, "op")} /></label> : null}
          </aside>) : null}
      </div>
      <AskInline env={env} sel={selection} placeholder="Ask the AI to change the selected shape, or redraw the picture…" />
    </div>
  );
}
