import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Icon } from "./Icon";
import type { Env } from "./docs/env";
import { layoutGraph, layoutSequence, nodeSize } from "../lib/graph";
import { useHistory } from "../lib/useHistory";
import { saveBlob, svgToPng } from "../lib/svgdoc";
import type { DiagramSpec, DocSelection, GEdge, GNode, GraphSpec, Message, Participant, SeqSpec } from "../types";

export const KIND_COLOR: Record<string, string> = {
  start: "#16a34a", end: "#dc2626", page: "#6366f1", action: "#f59e0b", process: "#64748b", decision: "#d946ef", entry: "#0ea5e9", root: "#2563eb",
  component: "#3b82f6", hook: "#8b5cf6", store: "#a855f7", data: "#10b981", util: "#14b8a6", style: "#ec4899", asset: "#f97316", service: "#e11d48",
  state: "#8b5cf6", output: "#22c55e", user: "#f59e0b", effect: "#06b6d4", html: "#f97316", package: "#94a3b8", config: "#78716c", module: "#64748b",
  types: "#0891b2", note: "#eab308", actor: "#f59e0b",
};
export const KINDS = Object.keys(KIND_COLOR);
const colorOf = (kind: string, custom?: string) => custom || KIND_COLOR[kind] || "#64748b";

export type DSel = { type: "node" | "edge" | "part" | "msg"; id: string } | null;
type View = { k: number; tx: number; ty: number };

function Shape({ n, box, theme, selected, connecting }: { n: GNode; box: { x: number; y: number; w: number; h: number }; theme: Theme; selected: boolean; connecting: boolean }) {
  const c = colorOf(n.kind, n.color);
  const common = { fill: c, fillOpacity: theme.dark ? 0.22 : 0.13, stroke: selected ? theme.accent : c, strokeWidth: selected ? 2.4 : 1.3 };
  const { x, y, w, h } = box;
  return (
    <g data-node={n.id} style={{ cursor: connecting ? "crosshair" : "grab" }}>
      {n.kind === "decision" ? <polygon points={`${x + w / 2},${y - 4} ${x + w + 8},${y + h / 2} ${x + w / 2},${y + h + 4} ${x - 8},${y + h / 2}`} {...common} />
        : <rect x={x} y={y} width={w} height={h} rx={n.kind === "start" || n.kind === "end" ? h / 2 : 9} {...common} />}
      <text x={x + w / 2} y={y + (n.sub ? 20 : h / 2 + 4.5)} textAnchor="middle" fontSize="12.5" fontWeight="600" fill={theme.text}>{clip(n.label, Math.floor(w / 7))}</text>
      {n.sub ? <text x={x + w / 2} y={y + 36} textAnchor="middle" fontSize="10.5" fill={theme.muted}>{clip(n.sub, Math.floor(w / 5.6))}</text> : null}
    </g>
  );
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);
type Theme = { dark: boolean; text: string; muted: string; line: string; bg: string; accent: string };
export const themeOf = (dark: boolean): Theme => ({ dark, text: dark ? "#ececee" : "#1a1a19", muted: dark ? "#9a9aa3" : "#77776f", line: dark ? "#6b7280" : "#94a3b8", bg: dark ? "#161618" : "#ffffff", accent: dark ? "#6ea0ff" : "#2563eb" });

/* ------------------------------------------------------------------------------------------ the picture */
type CanvasProps = {
  spec: DiagramSpec; theme: Theme; sel: DSel; onSelect: (s: DSel) => void; editable: boolean; connecting: boolean;
  onMove?: (id: string, x: number, y: number) => void; onConnect?: (from: string, to: string) => void; svgRef: RefObject<SVGSVGElement | null>;
  fitSignal: number;
};

function DiagramCanvas({ spec, theme, sel, onSelect, editable, connecting, onMove, onConnect, svgRef, fitSignal }: CanvasProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const graphSpec = spec.kind === "graph" ? spec : null;
  const live = useMemo<GraphSpec | null>(() => (graphSpec && drag ? { ...graphSpec, nodes: graphSpec.nodes.map((n) => (n.id === drag.id ? { ...n, x: drag.x, y: drag.y } : n)) } : graphSpec), [graphSpec, drag]);
  const glay = useMemo(() => (live ? layoutGraph(live) : null), [live]);
  const slay = useMemo(() => (spec.kind === "sequence" ? layoutSequence(spec) : null), [spec]);
  const size = glay ? { w: glay.width, h: glay.height } : { w: slay!.width, h: slay!.height };

  const fit = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    const k = Math.min(1.4, Math.max(0.2, Math.min((r.width - 24) / size.w, (r.height - 24) / size.h)));
    setView({ k, tx: (r.width - size.w * k) / 2, ty: Math.max(8, (r.height - size.h * k) / 2) });
  }, [size.w, size.h]);
  useEffect(() => { fit(); }, [fit, fitSignal, spec.type, spec.kind]);
  useEffect(() => {
    const ro = new ResizeObserver(() => fit());
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [fit]);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.tx) / view.k, y: (e.clientY - r.top - view.ty) / view.k };
  };

  const down = (e: React.PointerEvent) => {
    const t = e.target as Element;
    const nodeEl = t.closest("[data-node]") as SVGElement | null;
    const edgeEl = t.closest("[data-edge]") as SVGElement | null;
    const partEl = t.closest("[data-part]") as SVGElement | null;
    const msgEl = t.closest("[data-msg]") as SVGElement | null;
    wrap.current!.setPointerCapture(e.pointerId);
    if (nodeEl && glay) {
      const id = nodeEl.getAttribute("data-node")!;
      if (connecting && editable) {
        if (!from) { setFrom(id); onSelect({ type: "node", id }); } else { if (from !== id) onConnect?.(from, id); setFrom(null); }
        return;
      }
      onSelect({ type: "node", id });
      if (!editable) return;
      const b = glay.nodes[id], p = toLocal(e);
      let moved = false;
      const ox = p.x - b.x, oy = p.y - b.y;
      const move = (ev: PointerEvent) => {
        const q = toLocal(ev);
        if (!moved && Math.hypot(q.x - p.x, q.y - p.y) < 3) return;
        moved = true; setDrag({ id, x: Math.round(q.x - ox), y: Math.round(q.y - oy) });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        if (moved) { const q = toLocal(ev); onMove?.(id, Math.round(q.x - ox), Math.round(q.y - oy)); }
        setDrag(null);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      return;
    }
    if (edgeEl) { onSelect({ type: "edge", id: edgeEl.getAttribute("data-edge")! }); return; }
    if (partEl) { onSelect({ type: "part", id: partEl.getAttribute("data-part")! }); return; }
    if (msgEl) { onSelect({ type: "msg", id: msgEl.getAttribute("data-msg")! }); return; }
    // empty space: pan
    onSelect(null); setFrom(null);
    const sx = e.clientX, sy = e.clientY, v0 = view;
    const move = (ev: PointerEvent) => setView({ ...v0, tx: v0.tx + ev.clientX - sx, ty: v0.ty + ev.clientY - sy });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const wheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.min(3, Math.max(0.15, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    setView({ k, tx: mx - ((mx - view.tx) / view.k) * k, ty: my - ((my - view.ty) / view.k) * k });
  };
  const zoom = (f: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2, k = Math.min(3, Math.max(0.15, view.k * f));
    setView({ k, tx: mx - ((mx - view.tx) / view.k) * k, ty: my - ((my - view.ty) / view.k) * k });
  };

  const present = [...new Set(graphSpec ? graphSpec.nodes.map((n) => n.kind) : spec.kind === "sequence" ? spec.participants.map((p) => p.kind) : [])];
  return (
    <div className="dg-canvas" ref={wrap} onPointerDown={down} onWheel={wheel} data-connecting={connecting ? "1" : undefined}>
      <svg ref={svgRef} width="100%" height="100%" role="img" aria-label={spec.title || "diagram"} data-w={size.w} data-h={size.h}>
        <defs>
          <marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={theme.line} /></marker>
          <marker id="dg-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={theme.accent} /></marker>
        </defs>
        <g id="dg-viewport" transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
          <rect id="dg-bg" x="0" y="0" width={size.w} height={size.h} fill={theme.bg} />
          {glay && live ? (
            <>
              {glay.lanes.map((l) => (
                <g key={l.id}>
                  <rect x={l.x} y={l.y} width={l.w} height={l.h} rx="12" fill={theme.dark ? "#ffffff" : "#000000"} fillOpacity="0.035" stroke={theme.line} strokeOpacity="0.35" strokeDasharray="4 4" />
                  <text x={l.x + 12} y={l.y + 16} fontSize="11" fontWeight="700" letterSpacing="0.06em" fill={theme.muted}>{l.label.toUpperCase()}</text>
                </g>
              ))}
              {glay.edges.map((e) => {
                const on = sel?.type === "edge" && sel.id === e.id;
                return (
                  <g key={e.id} data-edge={e.id} style={{ cursor: "pointer" }}>
                    <path d={e.d} fill="none" stroke="transparent" strokeWidth="14" />
                    <path d={e.d} fill="none" stroke={on ? theme.accent : theme.line} strokeWidth={on ? 2.4 : 1.5} strokeDasharray={e.dashed ? "5 4" : undefined} markerEnd={`url(#${on ? "dg-arrow-sel" : "dg-arrow"})`} />
                    {e.label ? <text x={e.lx} y={e.ly - 5} textAnchor="middle" fontSize="10.5" fill={theme.muted} stroke={theme.bg} strokeWidth="4" paintOrder="stroke">{clip(e.label, 28)}</text> : null}
                  </g>
                );
              })}
              {live.nodes.map((n) => glay.nodes[n.id] ? <Shape key={n.id} n={n} box={glay.nodes[n.id]} theme={theme} selected={(sel?.type === "node" && sel.id === n.id) || from === n.id} connecting={connecting} /> : null)}
            </>
          ) : null}
          {slay && spec.kind === "sequence" ? (
            <>
              {slay.parts.map((p) => {
                const c = colorOf(p.kind, p.color), on = sel?.type === "part" && sel.id === p.id;
                return (
                  <g key={p.id} data-part={p.id} style={{ cursor: "pointer" }}>
                    <line x1={p.x} x2={p.x} y1={24 + slay.headH} y2={slay.height - 16} stroke={theme.line} strokeDasharray="4 4" strokeOpacity="0.7" />
                    <rect x={p.x - p.w / 2} y={24} width={p.w} height={slay.headH - 8} rx="9" fill={c} fillOpacity={theme.dark ? 0.22 : 0.13} stroke={on ? theme.accent : c} strokeWidth={on ? 2.4 : 1.3} />
                    <text x={p.x} y={24 + (slay.headH - 8) / 2 + 4.5} textAnchor="middle" fontSize="12.5" fontWeight="600" fill={theme.text}>{clip(p.label, Math.floor(p.w / 7))}</text>
                  </g>
                );
              })}
              {slay.msgs.map((m) => {
                const on = sel?.type === "msg" && sel.id === m.id, col = on ? theme.accent : theme.line;
                if (m.kind === "note") {
                  const xs = slay.parts.map((p) => p.x), x0 = Math.min(...xs) - 50, x1 = Math.max(...xs) + 50;
                  return (
                    <g key={m.id} data-msg={m.id} style={{ cursor: "pointer" }}>
                      <rect x={x0} y={m.y - 14} width={x1 - x0} height="26" rx="6" fill={KIND_COLOR.note} fillOpacity="0.15" stroke={on ? theme.accent : KIND_COLOR.note} strokeWidth={on ? 2.4 : 1} />
                      <text x={(x0 + x1) / 2} y={m.y + 4} textAnchor="middle" fontSize="11.5" fontWeight="700" fill={theme.text}>{m.label}</text>
                    </g>
                  );
                }
                if (m.self) {
                  return (
                    <g key={m.id} data-msg={m.id} style={{ cursor: "pointer" }}>
                      <path d={`M${m.x1},${m.y} h34 v24 h-34`} fill="none" stroke={col} strokeWidth={on ? 2.4 : 1.5} markerEnd={`url(#${on ? "dg-arrow-sel" : "dg-arrow"})`} />
                      <text x={m.x1 + 42} y={m.y + 15} fontSize="11.5" fill={theme.text}>{clip(m.label, 34)}</text>
                    </g>
                  );
                }
                const dir = m.x2 >= m.x1 ? 1 : -1, mid = (m.x1 + m.x2) / 2;
                return (
                  <g key={m.id} data-msg={m.id} style={{ cursor: "pointer" }}>
                    <line x1={m.x1} x2={m.x2} y1={m.y} y2={m.y} stroke="transparent" strokeWidth="14" />
                    <line x1={m.x1} x2={m.x2 - dir * 2} y1={m.y} y2={m.y} stroke={col} strokeWidth={on ? 2.4 : 1.5} strokeDasharray={m.kind === "return" ? "5 4" : undefined} markerEnd={`url(#${on ? "dg-arrow-sel" : "dg-arrow"})`} />
                    <text x={mid} y={m.y - 6} textAnchor="middle" fontSize="11.5" fill={theme.text} stroke={theme.bg} strokeWidth="4" paintOrder="stroke">{clip(m.label, Math.max(12, Math.floor(Math.abs(m.x2 - m.x1) / 6.2)))}</text>
                  </g>
                );
              })}
            </>
          ) : null}
        </g>
      </svg>
      <div className="dg-zoom">
        <button className="icon-btn sm" title="Zoom out" onClick={() => zoom(1 / 1.25)}><Icon name="zoomout" size={15} /></button>
        <span>{Math.round(view.k * 100)}%</span>
        <button className="icon-btn sm" title="Zoom in" onClick={() => zoom(1.25)}><Icon name="zoomin" size={15} /></button>
        <button className="icon-btn sm" title="Fit to window" onClick={fit}><Icon name="fit" size={15} /></button>
      </div>
      {present.length ? <div className="dg-legend">{present.map((k) => <span key={k}><i style={{ background: colorOf(k) }} />{k}</span>)}</div> : null}
      {connecting ? <div className="dg-hint">{from ? "Now click the node it points to" : "Click the node the arrow starts from"}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ the editor */
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;

type Props = {
  spec: DiagramSpec; onChange: (s: DiagramSpec) => void; env: Env; docId: string; docName: string; readOnly?: boolean;
  /** Extra toolbar content (e.g. regenerate / save to library in the Layers tab). */
  extra?: React.ReactNode;
  banner?: React.ReactNode;
  context?: string;
};

export function DiagramEditor({ spec, onChange, env, docId, docName, readOnly, extra, banner, context }: Props) {
  const [sel, setSel] = useState<DSel>(null);
  const [connecting, setConnecting] = useState(false);
  const [kind, setKind] = useState("process");
  const [fitSignal, setFitSignal] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  const hist = useHistory<DiagramSpec>(spec, onChange);
  const theme = useMemo(() => themeOf(env.dark), [env.dark]);
  const editable = !readOnly;
  const isSeq = spec.kind === "sequence";
  const g = spec.kind === "graph" ? spec : null;
  const seq = spec.kind === "sequence" ? spec : null;

  useEffect(() => { setSel(null); setConnecting(false); hist.reset(); }, [docId, spec.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchGraph = (fn: (s: GraphSpec) => GraphSpec, key?: string) => { if (g) hist.commit(fn(structuredClone(g)), key); };
  const patchSeq = (fn: (s: SeqSpec) => SeqSpec, key?: string) => { if (seq) hist.commit(fn(structuredClone(seq)), key); };

  // tell the workbench what is selected so "Ask AI" and forge_get_doc_selection know
  useEffect(() => {
    if (!sel) { env.onSelection(null); return; }
    let label = "", detail = "";
    if (g && sel.type === "node") { const n = g.nodes.find((x) => x.id === sel.id); if (n) { label = `Node “${n.label}” (${n.kind})`; detail = JSON.stringify({ node: n, edges: g.edges.filter((e) => e.from === n.id || e.to === n.id) }); } }
    if (g && sel.type === "edge") { const e = g.edges.find((x) => x.id === sel.id); if (e) { label = `Arrow ${e.from} → ${e.to}${e.label ? ` “${e.label}”` : ""}`; detail = JSON.stringify(e); } }
    if (seq && sel.type === "part") { const p = seq.participants.find((x) => x.id === sel.id); if (p) { label = `Participant “${p.label}”`; detail = JSON.stringify(p); } }
    if (seq && sel.type === "msg") { const m = seq.messages.find((x) => x.id === sel.id); if (m) { label = `Message “${m.label}” (${m.from} → ${m.to})`; detail = JSON.stringify(m); } }
    if (label) env.onSelection({ docId, docName, kind: "diagram", label, detail, text: label });
  }, [sel, g, seq, docId, docName]); // eslint-disable-line react-hooks/exhaustive-deps

  const selNode = g && sel?.type === "node" ? g.nodes.find((n) => n.id === sel.id) : undefined;
  const selEdge = g && sel?.type === "edge" ? g.edges.find((e) => e.id === sel.id) : undefined;
  const selPart = seq && sel?.type === "part" ? seq.participants.find((p) => p.id === sel.id) : undefined;
  const selMsg = seq && sel?.type === "msg" ? seq.messages.find((m) => m.id === sel.id) : undefined;

  const addNode = () => patchGraph((s) => {
    const id = uid("n");
    const anchor = selNode;
    s.nodes.push({ id, label: "New " + kind, kind, ...(anchor?.group ? { group: anchor.group } : {}) });
    if (anchor) s.edges.push({ id: uid("e"), from: anchor.id, to: id });
    setSel({ type: "node", id });
    return s;
  });
  const deleteSel = () => {
    if (g && selNode) { patchGraph((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== selNode.id), edges: s.edges.filter((e) => e.from !== selNode.id && e.to !== selNode.id) })); setSel(null); }
    else if (g && selEdge) { patchGraph((s) => ({ ...s, edges: s.edges.filter((e) => e.id !== selEdge.id) })); setSel(null); }
    else if (seq && selPart) { patchSeq((s) => ({ ...s, participants: s.participants.filter((p) => p.id !== selPart.id), messages: s.messages.filter((m) => m.from !== selPart.id && m.to !== selPart.id) })); setSel(null); }
    else if (seq && selMsg) { patchSeq((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== selMsg.id) })); setSel(null); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable=true]") || !editable) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); deleteSel(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) hist.redo(); else hist.undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const exportAs = async (fmt: "svg" | "png") => {
    setExportOpen(false);
    const el = svgRef.current;
    if (!el) return;
    const w = Number(el.getAttribute("data-w")), h = Number(el.getAttribute("data-h"));
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("viewBox", `0 0 ${w} ${h}`); clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h));
    clone.querySelector("#dg-viewport")?.setAttribute("transform", "");
    const text = new XMLSerializer().serializeToString(clone);
    const base = (docName || spec.title || "diagram").replace(/\.diagram\.json$|\.json$/i, "");
    try {
      if (fmt === "svg") await saveBlob(env.download, new Blob([text], { type: "image/svg+xml" }), `${base}.svg`);
      else await saveBlob(env.download, await svgToPng(text, w, h, 2, theme.bg), `${base}.png`);
      env.say(`Exported ${base}.${fmt}`);
    } catch (e) { env.say(e instanceof Error ? e.message : String(e)); }
  };

  const nodeOpts = g ? g.nodes : [];
  return (
    <div className="dg">
      <div className="dg-bar">
        {editable && g ? (
          <>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="New node type" title="Type of the new node">{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
            <button onClick={addNode} title="Add a node (connected to the selected one)"><Icon name="plus" size={14} /> Node</button>
            <button className={connecting ? "on" : ""} onClick={() => setConnecting(!connecting)} title="Draw an arrow between two nodes"><Icon name="link" size={14} /> Connect</button>
            <button onClick={() => patchGraph((s) => ({ ...s, direction: s.direction === "TB" ? "LR" : "TB" }))} title="Flow direction">{g.direction === "TB" ? "↓ Top-down" : "→ Left-right"}</button>
            <button onClick={() => { patchGraph((s) => ({ ...s, nodes: s.nodes.map(({ x: _x, y: _y, ...n }) => n) })); setFitSignal((n) => n + 1); }} title="Reset hand-placed nodes">Auto-layout</button>
          </>
        ) : null}
        {editable && seq ? (
          <>
            <button onClick={() => patchSeq((s) => { const id = uid("p"); s.participants.push({ id, label: "Participant", kind: "component" }); setSel({ type: "part", id }); return s; })}><Icon name="plus" size={14} /> Participant</button>
            <button disabled={seq.participants.length < 2} onClick={() => patchSeq((s) => { const id = uid("m"); s.messages.push({ id, from: s.participants[0].id, to: s.participants[1].id, label: "message", kind: "call" }); setSel({ type: "msg", id }); return s; })}><Icon name="plus" size={14} /> Message</button>
          </>
        ) : null}
        {editable ? <button className="icon-btn" title="Delete selected (Del)" disabled={!sel} onClick={deleteSel}><Icon name="trash" size={16} /></button> : null}
        {editable ? <><button className="icon-btn" title="Undo" disabled={!hist.canUndo} onClick={hist.undo}><Icon name="undo" size={16} /></button>
          <button className="icon-btn" title="Redo" disabled={!hist.canRedo} onClick={hist.redo}><Icon name="redo" size={16} /></button></> : null}
        <span className="grow" />
        {extra}
        <div className="menu-wrap">
          <button onClick={() => setExportOpen(!exportOpen)} title="Export the picture"><Icon name="download" size={14} /> Export</button>
          {exportOpen ? (
            <div className="menu small right" onMouseLeave={() => setExportOpen(false)}>
              <button className="menu-item" onClick={() => void exportAs("svg")}>SVG (vector)</button>
              <button className="menu-item" onClick={() => void exportAs("png")}>PNG (image)</button>
            </div>
          ) : null}
        </div>
      </div>
      {banner}
      <div className="dg-main">
        <DiagramCanvas spec={spec} theme={theme} sel={sel} onSelect={setSel} editable={editable} connecting={connecting} svgRef={svgRef} fitSignal={fitSignal}
          onMove={(id, x, y) => patchGraph((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) }))}
          onConnect={(a, b) => { patchGraph((s) => { if (!s.edges.some((e) => e.from === a && e.to === b)) s.edges.push({ id: uid("e"), from: a, to: b }); return s; }); setConnecting(false); }} />
        <aside className="dg-side">
          {selNode ? (
            <>
              <h4>Node</h4>
              <label>Label<input value={selNode.label} disabled={!editable} onChange={(e) => patchGraph((s) => { s.nodes.find((n) => n.id === selNode.id)!.label = e.target.value; return s; }, "lbl" + selNode.id)} /></label>
              <label>Detail<input value={selNode.sub ?? ""} disabled={!editable} onChange={(e) => patchGraph((s) => { s.nodes.find((n) => n.id === selNode.id)!.sub = e.target.value || undefined; return s; }, "sub" + selNode.id)} /></label>
              <label>Type<select value={selNode.kind} disabled={!editable} onChange={(e) => patchGraph((s) => { s.nodes.find((n) => n.id === selNode.id)!.kind = e.target.value; return s; })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
              {g?.groups?.length ? <label>Column<select value={selNode.group ?? ""} disabled={!editable} onChange={(e) => patchGraph((s) => { const n = s.nodes.find((x) => x.id === selNode.id)!; if (e.target.value) n.group = e.target.value; else delete n.group; return s; })}><option value="">(none)</option>{g.groups.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label> : null}
              <label>Colour<span className="row"><input type="color" value={selNode.color ?? colorOf(selNode.kind)} disabled={!editable} onChange={(e) => patchGraph((s) => { s.nodes.find((n) => n.id === selNode.id)!.color = e.target.value; return s; }, "col" + selNode.id)} />
                {selNode.color ? <button className="link-btn" onClick={() => patchGraph((s) => { delete s.nodes.find((n) => n.id === selNode.id)!.color; return s; })}>reset</button> : null}</span></label>
              {selNode.file ? <button onClick={() => env.openFile(selNode.file!, selNode.line)}><Icon name="code" size={14} /> Open {selNode.file.split("/").pop()}{selNode.line ? `:${selNode.line}` : ""}</button> : null}
              <div className="muted small">{g!.edges.filter((e) => e.from === selNode.id).length} out · {g!.edges.filter((e) => e.to === selNode.id).length} in</div>
            </>
          ) : selEdge ? (
            <>
              <h4>Arrow</h4>
              <div className="muted">{nodeOpts.find((n) => n.id === selEdge.from)?.label} → {nodeOpts.find((n) => n.id === selEdge.to)?.label}</div>
              <label>Label<input value={selEdge.label ?? ""} disabled={!editable} onChange={(e) => patchGraph((s) => { const x = s.edges.find((q) => q.id === selEdge.id)!; if (e.target.value) x.label = e.target.value; else delete x.label; return s; }, "el" + selEdge.id)} /></label>
              <label className="check"><input type="checkbox" checked={Boolean(selEdge.dashed)} disabled={!editable} onChange={(e) => patchGraph((s) => { const x = s.edges.find((q) => q.id === selEdge.id)!; if (e.target.checked) x.dashed = true; else delete x.dashed; return s; })} /> Dashed</label>
              {editable ? <button onClick={() => patchGraph((s) => { const x = s.edges.find((q) => q.id === selEdge.id)!; [x.from, x.to] = [x.to, x.from]; return s; })}>Reverse direction</button> : null}
            </>
          ) : selPart ? (
            <>
              <h4>Participant</h4>
              <label>Name<input value={selPart.label} disabled={!editable} onChange={(e) => patchSeq((s) => { s.participants.find((p) => p.id === selPart.id)!.label = e.target.value; return s; }, "pl" + selPart.id)} /></label>
              <label>Type<select value={selPart.kind} disabled={!editable} onChange={(e) => patchSeq((s) => { s.participants.find((p) => p.id === selPart.id)!.kind = e.target.value; return s; })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
              {editable ? <span className="row"><button onClick={() => patchSeq((s) => { const i = s.participants.findIndex((p) => p.id === selPart.id); if (i > 0) [s.participants[i - 1], s.participants[i]] = [s.participants[i], s.participants[i - 1]]; return s; })}>← Move left</button>
                <button onClick={() => patchSeq((s) => { const i = s.participants.findIndex((p) => p.id === selPart.id); if (i < s.participants.length - 1) [s.participants[i + 1], s.participants[i]] = [s.participants[i], s.participants[i + 1]]; return s; })}>Move right →</button></span> : null}
              {selPart.file ? <button onClick={() => env.openFile(selPart.file!)}><Icon name="code" size={14} /> Open {selPart.file.split("/").pop()}</button> : null}
            </>
          ) : selMsg && seq ? (
            <>
              <h4>Message</h4>
              <label>Text<input value={selMsg.label} disabled={!editable} onChange={(e) => patchSeq((s) => { s.messages.find((m) => m.id === selMsg.id)!.label = e.target.value; return s; }, "ml" + selMsg.id)} /></label>
              <label>Kind<select value={selMsg.kind} disabled={!editable} onChange={(e) => patchSeq((s) => { s.messages.find((m) => m.id === selMsg.id)!.kind = e.target.value as Message["kind"]; return s; })}>{["call", "return", "self", "note"].map((k) => <option key={k}>{k}</option>)}</select></label>
              {selMsg.kind !== "note" ? <>
                <label>From<select value={selMsg.from} disabled={!editable} onChange={(e) => patchSeq((s) => { s.messages.find((m) => m.id === selMsg.id)!.from = e.target.value; return s; })}>{seq.participants.map((p: Participant) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
                <label>To<select value={selMsg.to} disabled={!editable} onChange={(e) => patchSeq((s) => { s.messages.find((m) => m.id === selMsg.id)!.to = e.target.value; return s; })}>{seq.participants.map((p: Participant) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label></> : null}
              {editable ? <span className="row"><button onClick={() => patchSeq((s) => { const i = s.messages.findIndex((m) => m.id === selMsg.id); if (i > 0) [s.messages[i - 1], s.messages[i]] = [s.messages[i], s.messages[i - 1]]; return s; })}>↑ Earlier</button>
                <button onClick={() => patchSeq((s) => { const i = s.messages.findIndex((m) => m.id === selMsg.id); if (i < s.messages.length - 1) [s.messages[i + 1], s.messages[i]] = [s.messages[i], s.messages[i + 1]]; return s; })}>↓ Later</button></span> : null}
            </>
          ) : (
            <>
              <h4>Diagram</h4>
              <label>Title<input value={spec.title} disabled={!editable} onChange={(e) => hist.commit({ ...spec, title: e.target.value }, "title")} /></label>
              <div className="muted small">{g ? `${g.nodes.length} nodes · ${g.edges.length} arrows` : `${seq!.participants.length} participants · ${seq!.messages.length} messages`}</div>
              <div className="muted small">{isSeq ? "Click a participant or message to edit it." : "Click a node or arrow to edit it. Drag nodes to move them. Scroll to zoom, drag the background to pan."}</div>
              {context ? <div className="muted small">{context}</div> : null}
            </>
          )}
          {sel && editable ? <button className="danger" onClick={deleteSel}><Icon name="trash" size={14} /> Delete</button> : null}
        </aside>
      </div>
      <AskInline env={env} sel={selectionOf(sel, g, seq, docId, docName)} placeholder="Ask the AI to change this diagram…" />
    </div>
  );
}

function selectionOf(sel: DSel, g: GraphSpec | null, seq: SeqSpec | null, docId: string, docName: string): DocSelection | null {
  if (!sel) return null;
  if (g && sel.type === "node") { const n = g.nodes.find((x) => x.id === sel.id); return n ? { docId, docName, kind: "diagram", label: `node “${n.label}”`, detail: JSON.stringify(n) } : null; }
  if (g && sel.type === "edge") { const e = g.edges.find((x) => x.id === sel.id); return e ? { docId, docName, kind: "diagram", label: "the selected arrow", detail: JSON.stringify(e) } : null; }
  if (seq && sel.type === "part") { const p = seq.participants.find((x) => x.id === sel.id); return p ? { docId, docName, kind: "diagram", label: `participant “${p.label}”`, detail: JSON.stringify(p) } : null; }
  if (seq && sel.type === "msg") { const m = seq.messages.find((x) => x.id === sel.id); return m ? { docId, docName, kind: "diagram", label: `message “${m.label}”`, detail: JSON.stringify(m) } : null; }
  return null;
}

/** A one-line "ask the AI" box that mentions the current selection. */
export function AskInline({ env, sel, placeholder }: { env: Env; sel: DocSelection | null; placeholder: string }) {
  const [text, setText] = useState("");
  if (!env.canAsk) return null;
  if (env.hostChat) return (
    <div className="askbar host">
      <Icon name="sparkle" size={15} />
      {sel ? <span className="chip" title={sel.text || sel.detail}>{sel.label}</span> : <span className="muted">Nothing selected: Claude sees the whole document.</span>}
      <span className="muted">{sel ? "Shared with Claude. Type your change in Claude's chat." : "Select a part, then type your change in Claude's chat."}</span>
    </div>
  );
  const send = () => { if (text.trim()) { env.ask(text.trim(), sel); setText(""); } };
  return (
    <div className="askbar">
      <Icon name="sparkle" size={15} />
      {sel ? <span className="chip" title={sel.text || sel.detail}>{sel.label}</span> : <span className="muted">No selection: the AI sees the whole document.</span>}
      <input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
      <button className="primary" disabled={!text.trim()} onClick={send}>{env.askLabel}</button>
    </div>
  );
}
export type { GNode, GEdge };
export { nodeSize };
