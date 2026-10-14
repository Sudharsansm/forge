import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import { AskInline } from "../Diagram";
import type { DocSelection } from "../../types";
import { b64Of, dataUrl } from "./shared";
import type { EditorProps } from "./shared";

type Tool = "select" | "brush" | "rect" | "text";
type R = { x: number; y: number; w: number; h: number };
const MAX_SIDE = 4096;

/** Raster images: select a region (the AI is told which pixels), crop, rotate, flip, adjust, draw and annotate. */
export function ImageEditor({ item, payload, onChange, env, readOnly }: EditorProps) {
  const mime: string = /^image\/(png|jpeg|webp)$/.test(payload.mime) ? payload.mime : "image/png";
  const cv = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [region, setRegion] = useState<R | null>(null);
  const [color, setColor] = useState("#ef4444");
  const [size, setSize] = useState(6);
  const [adj, setAdj] = useState({ brightness: 100, contrast: 100, saturate: 100 });
  const [dim, setDim] = useState({ w: payload.width ?? 0, h: payload.height ?? 0 });
  const [stack, setStack] = useState<string[]>([]);
  const [pos, setPos] = useState(0);
  const [busy, setBusy] = useState(false);
  const dragRef = useRef<{ x: number; y: number; last?: { x: number; y: number } } | null>(null);
  const pending = useRef<ImageData | null>(null);
  const cdn = () => cv.current!;
  const ctx = () => cdn().getContext("2d", { willReadFrequently: true })!;

  const load = (url: string) => new Promise<void>((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const c = cdn(); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      ctx().clearRect(0, 0, c.width, c.height); ctx().drawImage(img, 0, 0, c.width, c.height);
      setDim({ w: c.width, h: c.height }); res();
    };
    img.onerror = () => rej(new Error("Could not open the image"));
    img.src = url;
  });
  useEffect(() => {
    if (!payload.base64) return;
    const u = dataUrl(payload.mime || "image/png", payload.base64);
    load(u).then(() => { setStack([u]); setPos(0); setRegion(null); }).catch((e) => env.say(e.message));
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapshot = () => {
    const u = cdn().toDataURL(mime, 0.92);
    const next = [...stack.slice(0, pos + 1), u].slice(-16);
    setStack(next); setPos(next.length - 1);
    onChange({ ...payload, base64: b64Of(u), mime, width: cdn().width, height: cdn().height });
  };
  const goto = async (p: number) => { if (p < 0 || p >= stack.length) return; await load(stack[p]); setPos(p); setRegion(null); onChange({ ...payload, base64: b64Of(stack[p]), mime, width: cdn().width, height: cdn().height }); };

  const toPx = (e: React.PointerEvent) => {
    const r = cdn().getBoundingClientRect();
    return { x: Math.max(0, Math.min(cdn().width, ((e.clientX - r.left) / r.width) * cdn().width)), y: Math.max(0, Math.min(cdn().height, ((e.clientY - r.top) / r.height) * cdn().height)) };
  };
  const down = (e: React.PointerEvent) => {
    const p = toPx(e);
    if (readOnly && tool !== "select") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "text") {
      const t = prompt("Text to add");
      if (t) { const c = ctx(); c.fillStyle = color; c.font = `${Math.max(12, size * 4)}px system-ui, sans-serif`; c.textBaseline = "top"; c.fillText(t, p.x, p.y); snapshot(); }
      return;
    }
    dragRef.current = { x: p.x, y: p.y, last: p };
    if (tool === "rect") pending.current = ctx().getImageData(0, 0, cdn().width, cdn().height);
    if (tool === "select") setRegion({ x: p.x, y: p.y, w: 0, h: 0 });
    if (tool === "brush") { const c = ctx(); c.strokeStyle = color; c.lineWidth = size; c.lineCap = c.lineJoin = "round"; c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + 0.01, p.y); c.stroke(); }
  };
  const move = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const p = toPx(e), c = ctx();
    if (tool === "select") setRegion({ x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) });
    else if (tool === "brush" && d.last) { c.beginPath(); c.moveTo(d.last.x, d.last.y); c.lineTo(p.x, p.y); c.stroke(); d.last = p; }
    else if (tool === "rect" && pending.current) { c.putImageData(pending.current, 0, 0); c.strokeStyle = color; c.lineWidth = size; c.strokeRect(d.x, d.y, p.x - d.x, p.y - d.y); }
  };
  const up = () => {
    const d = dragRef.current; dragRef.current = null; pending.current = null;
    if (!d) return;
    if (tool === "select") setRegion((r) => (r && r.w > 3 && r.h > 3 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null));
    else snapshot();
  };

  const transform = (fn: (src: HTMLCanvasElement, c: HTMLCanvasElement) => void) => {
    const src = document.createElement("canvas"); src.width = cdn().width; src.height = cdn().height; src.getContext("2d")!.drawImage(cdn(), 0, 0);
    fn(src, cdn()); setDim({ w: cdn().width, h: cdn().height }); setRegion(null); snapshot();
  };
  const rotate = (dir: 1 | -1) => transform((s, c) => { c.width = s.height; c.height = s.width; const g = ctx(); g.save(); g.translate(c.width / 2, c.height / 2); g.rotate((dir * Math.PI) / 2); g.drawImage(s, -s.width / 2, -s.height / 2); g.restore(); });
  const flip = (h: boolean) => transform((s, c) => { const g = ctx(); g.save(); g.clearRect(0, 0, c.width, c.height); g.translate(h ? c.width : 0, h ? 0 : c.height); g.scale(h ? -1 : 1, h ? 1 : -1); g.drawImage(s, 0, 0); g.restore(); });
  const crop = () => { if (!region) return; const r = region; transform((s, c) => { c.width = r.w; c.height = r.h; ctx().drawImage(s, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); }); };
  const applyAdj = () => transform((s, c) => { const g = ctx(); g.clearRect(0, 0, c.width, c.height); g.filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturate}%)`; g.drawImage(s, 0, 0); g.filter = "none"; setAdj({ brightness: 100, contrast: 100, saturate: 100 }); });
  const grayscale = () => transform((s, c) => { const g = ctx(); g.filter = "grayscale(100%)"; g.drawImage(s, 0, 0); g.filter = "none"; void c; });
  const resize = () => {
    const w = Number(prompt("New width in pixels", String(dim.w)));
    if (!w || w < 8 || w > MAX_SIDE) return;
    const h = Math.round((dim.h * w) / dim.w);
    transform((s, c) => { c.width = w; c.height = h; ctx().imageSmoothingQuality = "high"; ctx().drawImage(s, 0, 0, w, h); });
  };

  const selection = useMemo<DocSelection | null>(() => region
    ? { docId: item.id, docName: item.name, kind: "image", label: `region ${region.w}×${region.h}px at (${region.x}, ${region.y})`, detail: JSON.stringify({ ...region, imageWidth: dim.w, imageHeight: dim.h }) }
    : null, [region, item, dim]);
  useEffect(() => { env.onSelection(selection); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  const filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturate}%)`;
  const k = cv.current ? cv.current.getBoundingClientRect().width / (dim.w || 1) : 1;
  void busy; void setBusy;

  if (!payload.base64) return <div className="empty big">This image is too large to open here ({dim.w}×{dim.h}). Download it instead.</div>;
  return (
    <div className="imged">
      <div className="dg-bar">
        <button className="icon-btn" title="Undo" disabled={pos <= 0} onClick={() => void goto(pos - 1)}><Icon name="undo" size={16} /></button>
        <button className="icon-btn" title="Redo" disabled={pos >= stack.length - 1} onClick={() => void goto(pos + 1)}><Icon name="redo" size={16} /></button>
        {([["select", "Select area", "cursor"], ["brush", "Draw", "brush"], ["rect", "Box", "grid"], ["text", "Text", "type"]] as const).map(([id, t, ic]) => (
          <button key={id} className={tool === id ? "on" : ""} disabled={readOnly && id !== "select"} onClick={() => setTool(id)}><Icon name={ic} size={14} /> {t}</button>))}
        {tool === "brush" || tool === "rect" || tool === "text" ? <><input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour" /><input type="range" min="1" max="30" value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Size" /></> : null}
        {!readOnly ? <>
          <span className="sep" />
          <button disabled={!region} onClick={crop}><Icon name="crop" size={14} /> Crop</button>
          <button className="icon-btn" title="Rotate left" onClick={() => rotate(-1)}><Icon name="rotate" size={16} /></button>
          <button className="icon-btn" title="Rotate right" onClick={() => rotate(1)}><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><Icon name="rotate" size={16} /></span></button>
          <button onClick={() => flip(true)}>⇆</button><button onClick={() => flip(false)}>⇅</button><button onClick={resize}>Resize</button></> : null}
        <span className="grow" /><span className="muted small">{dim.w}×{dim.h}px</span>
      </div>
      <div className="img-main">
        <div className="img-stage">
          <div className="img-wrap" style={{ cursor: tool === "select" ? "crosshair" : tool === "text" ? "text" : "crosshair" }} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
            <canvas ref={cv} style={{ filter, maxWidth: "100%", maxHeight: "100%", display: "block" }} />
            {region ? <div className="sel-box" style={{ left: region.x * k, top: region.y * k, width: region.w * k, height: region.h * k }} /> : null}
          </div>
        </div>
        {!readOnly ? (
          <aside className="dg-side">
            <h4>Adjust</h4>
            {(["brightness", "contrast", "saturate"] as const).map((n) => <label key={n}>{n[0].toUpperCase() + n.slice(1)}<input type="range" min="0" max="200" value={adj[n]} onChange={(e) => setAdj({ ...adj, [n]: Number(e.target.value) })} /></label>)}
            <div className="row"><button className="primary" disabled={adj.brightness === 100 && adj.contrast === 100 && adj.saturate === 100} onClick={applyAdj}>Apply</button><button onClick={() => setAdj({ brightness: 100, contrast: 100, saturate: 100 })}>Reset</button></div>
            <button onClick={grayscale}>Black and white</button>
            <div className="muted small">With “Select area”, drag over part of the picture, then ask the AI about just that region, or crop to it.</div>
          </aside>) : null}
      </div>
      <AskInline env={env} sel={selection} placeholder="Ask the AI about the selected area, or the whole image…" />
    </div>
  );
}
