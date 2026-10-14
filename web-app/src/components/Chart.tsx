import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Icon } from "./Icon";
import { AskInline, themeOf } from "./Diagram";
import type { Env } from "./docs/env";
import { PALETTE, arc, colorOf, dataRange, fmt, niceTicks, vals } from "../lib/chart";
import { useHistory } from "../lib/useHistory";
import { saveBlob, svgToPng } from "../lib/svgdoc";
import type { ChartSpec, ChartType, DocSelection } from "../types";

export type CSel = { kind: "point"; s: number; i: number } | { kind: "series"; s: number } | { kind: "title" } | null;
const W = 640, H = 400;

type ViewProps = { spec: ChartSpec; dark: boolean; sel: CSel; onSelect?: (s: CSel) => void; svgRef?: RefObject<SVGSVGElement | null> };

export function ChartView({ spec, dark, sel, onSelect, svgRef }: ViewProps) {
  const th = themeOf(dark);
  const isPie = spec.type === "pie" || spec.type === "donut";
  const multi = spec.series.length > 1;
  const legendItems = isPie ? spec.labels.map((l, i) => ({ name: l, color: colorOf(spec, 0, i) })) : spec.series.map((s, i) => ({ name: s.name, color: colorOf(spec, i) }));
  const showLegend = spec.legend && (isPie || multi) && legendItems.length > 0;
  const top = spec.title || spec.subtitle ? 62 : 24, bottom = 44 + (showLegend ? 24 : 0) + (spec.xLabel ? 16 : 0), left = spec.type === "hbar" ? 96 : 58 + (spec.yLabel ? 16 : 0), right = 24;
  const pw = W - left - right, ph = H - top - bottom;
  const n = spec.labels.length;
  const horizontal = spec.type === "hbar";
  const { min, max } = dataRange(spec);
  const t = niceTicks(min, max);
  const val = (v: number) => (horizontal ? left + ((v - t.lo) / (t.hi - t.lo)) * pw : top + ph - ((v - t.lo) / (t.hi - t.lo)) * ph);
  const band = (horizontal ? ph : pw) / Math.max(1, n);
  const catPos = (i: number) => (horizontal ? top + band * i : left + band * i);
  const isSel = (s: number, i?: number) => sel?.kind === "series" ? sel.s === s : sel?.kind === "point" && sel.s === s && (i === undefined || sel.i === i);
  const mark = (s: number, i: number) => ({ "data-p": `${s}:${i}`, style: { cursor: onSelect ? "pointer" : undefined } });
  const pick = (e: React.MouseEvent) => {
    if (!onSelect) return;
    const el = (e.target as Element).closest("[data-p],[data-title]");
    if (!el) { onSelect(null); return; }
    if (el.hasAttribute("data-title")) { onSelect({ kind: "title" }); return; }
    const [s, i] = el.getAttribute("data-p")!.split(":").map(Number);
    onSelect({ kind: "point", s, i });
  };
  const sw = (on: boolean) => (on ? { stroke: th.accent, strokeWidth: 2.5 } : {});

  const bars = () => spec.series.flatMap((_ser, s) => vals(spec, s).map((v, i) => {
    if (v === null) return null;
    const c = colorOf(spec, s, i);
    const groupW = band * 0.78, bw = spec.type === "stacked" ? groupW : groupW / spec.series.length, off = (band - groupW) / 2 + (spec.type === "stacked" ? 0 : s * bw);
    let base = 0;
    if (spec.type === "stacked") for (let q = 0; q < s; q++) base += vals(spec, q)[i] ?? 0;
    const a = val(base), b = val(base + v);
    const rect = horizontal ? { x: Math.min(a, b), y: catPos(i) + off, width: Math.abs(b - a), height: bw - 2 } : { x: catPos(i) + off, y: Math.min(a, b), width: bw - 2, height: Math.abs(b - a) };
    return (
      <g key={`${s}-${i}`} {...mark(s, i)}>
        <rect {...rect} rx="3" fill={c} {...sw(isSel(s, i))} />
        {spec.showValues ? <text x={horizontal ? rect.x + rect.width + 4 : rect.x + rect.width / 2} y={horizontal ? rect.y + rect.height / 2 + 4 : rect.y - 5} textAnchor={horizontal ? "start" : "middle"} fontSize="10.5" fill={th.text}>{fmt(v)}</text> : null}
      </g>
    );
  }));

  const lines = () => spec.series.map((_ser, s) => {
    const pts = vals(spec, s).map((v, i) => (v === null ? null : { x: left + band * (i + 0.5), y: val(v), v, i }));
    const segs: string[] = [];
    let cur = "";
    pts.forEach((p) => { if (!p) { if (cur) segs.push(cur); cur = ""; } else cur += `${cur ? "L" : "M"}${p.x},${p.y}`; });
    if (cur) segs.push(cur);
    const c = colorOf(spec, s);
    return (
      <g key={s}>
        {spec.type === "area" ? pts.filter(Boolean).length > 1 ? <path d={`${segs[0]} L${pts.filter(Boolean).slice(-1)[0]!.x},${val(0)} L${pts.find(Boolean)!.x},${val(0)} Z`} fill={c} fillOpacity="0.18" /> : null : null}
        {segs.map((d, k) => <path key={k} d={d} fill="none" stroke={c} strokeWidth={isSel(s) ? 3.2 : 2.2} strokeLinejoin="round" />)}
        {pts.map((p) => p ? (
          <g key={p.i} {...mark(s, p.i)}>
            <circle cx={p.x} cy={p.y} r="10" fill="transparent" />
            <circle cx={p.x} cy={p.y} r={isSel(s, p.i) ? 6 : 4} fill={colorOf(spec, s, p.i)} stroke={isSel(s, p.i) ? th.accent : th.bg} strokeWidth="2" />
            {spec.showValues ? <text x={p.x} y={p.y - 9} textAnchor="middle" fontSize="10.5" fill={th.text}>{fmt(p.v)}</text> : null}
          </g>
        ) : null)}
      </g>
    );
  });

  const pie = () => {
    const data = vals(spec, 0).map((v, i) => ({ v: Math.max(0, v ?? 0), i }));
    const total = data.reduce((s, d) => s + d.v, 0) || 1;
    const cx = W / 2, cy = top + ph / 2, r = Math.min(pw, ph) / 2 - 14, r0 = spec.type === "donut" ? r * 0.58 : 0;
    let a = 0;
    return (
      <g>
        {data.map((d) => {
          const a0 = a, a1 = a + (d.v / total) * Math.PI * 2;
          a = a1;
          if (d.v <= 0) return null;
          const mid = (a0 + a1) / 2, on = isSel(0, d.i);
          const full = a1 - a0 > Math.PI * 2 - 0.001;
          return (
            <g key={d.i} {...mark(0, d.i)}>
              {full ? <circle cx={cx} cy={cy} r={r} fill={colorOf(spec, 0, d.i)} {...sw(on)} /> : <path d={arc(cx, cy, r + (on ? 5 : 0), r0, a0, a1)} fill={colorOf(spec, 0, d.i)} stroke={on ? th.accent : th.bg} strokeWidth={on ? 2.5 : 1.5} />}
              {(a1 - a0) > 0.22 ? <text x={cx + (r0 ? (r + r0) / 2 : r * 0.64) * Math.sin(mid)} y={cy - (r0 ? (r + r0) / 2 : r * 0.64) * Math.cos(mid) + 4} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#fff">{spec.showValues ? fmt(d.v) : `${Math.round((d.v / total) * 100)}%`}</text> : null}
            </g>
          );
        })}
        {spec.type === "donut" ? <text x={cx} y={cy + 5} textAnchor="middle" fontSize="15" fontWeight="700" fill={th.text}>{fmt(total)}</text> : null}
      </g>
    );
  };

  const scatter = () => {
    const xs = spec.series.flatMap((s) => (s.points ?? []).map((p) => p.x));
    const xt = niceTicks(Math.min(0, ...xs), Math.max(1, ...xs));
    const px = (x: number) => left + ((x - xt.lo) / (xt.hi - xt.lo)) * pw;
    return (
      <g>
        {xt.ticks.map((v) => <text key={v} x={px(v)} y={top + ph + 16} textAnchor="middle" fontSize="10.5" fill={th.muted}>{fmt(v)}</text>)}
        {spec.series.flatMap((s, si) => (s.points ?? []).map((p, i) => (
          <g key={`${si}-${i}`} {...mark(si, i)}><circle cx={px(p.x)} cy={val(p.y)} r={isSel(si, i) ? 7 : 5} fill={colorOf(spec, si, i)} fillOpacity="0.85" stroke={isSel(si, i) ? th.accent : th.bg} strokeWidth="2" /></g>
        )))}
      </g>
    );
  };

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: "100%", display: "block" }} onClick={pick} role="img" aria-label={spec.title || "chart"} data-w={W} data-h={H}>
      <rect id="ch-bg" width={W} height={H} fill={th.bg} />
      {spec.title ? <text data-title="1" x={left} y="28" fontSize="17" fontWeight="700" fill={sel?.kind === "title" ? th.accent : th.text} style={{ cursor: onSelect ? "pointer" : undefined }}>{spec.title}</text> : null}
      {spec.subtitle ? <text data-title="1" x={left} y="47" fontSize="12" fill={th.muted}>{spec.subtitle}</text> : null}
      {!isPie && spec.type !== "scatter" ? (
        <g>
          {t.ticks.map((v) => (
            <g key={v}>
              {spec.grid ? (horizontal ? <line x1={val(v)} x2={val(v)} y1={top} y2={top + ph} stroke={th.line} strokeOpacity="0.28" /> : <line x1={left} x2={left + pw} y1={val(v)} y2={val(v)} stroke={th.line} strokeOpacity="0.28" />) : null}
              {horizontal ? <text x={val(v)} y={top + ph + 16} textAnchor="middle" fontSize="10.5" fill={th.muted}>{fmt(v)}</text> : <text x={left - 8} y={val(v) + 4} textAnchor="end" fontSize="10.5" fill={th.muted}>{fmt(v)}</text>}
            </g>
          ))}
          {spec.labels.map((l, i) => horizontal
            ? <text key={i} x={left - 8} y={catPos(i) + band / 2 + 4} textAnchor="end" fontSize="11" fill={th.muted}>{l.length > 14 ? l.slice(0, 13) + "…" : l}</text>
            : <text key={i} x={left + band * (i + 0.5)} y={top + ph + 16} textAnchor="middle" fontSize="11" fill={th.muted}>{l.length > Math.max(6, band / 6) ? l.slice(0, Math.max(5, Math.floor(band / 6))) + "…" : l}</text>)}
          {horizontal ? null : <line x1={left} x2={left + pw} y1={val(0)} y2={val(0)} stroke={th.line} />}
          {horizontal ? <line x1={val(0)} x2={val(0)} y1={top} y2={top + ph} stroke={th.line} /> : null}
        </g>
      ) : null}
      {spec.type === "scatter" ? <g>{niceTicks(min, max).ticks.map((v) => <g key={v}>{spec.grid ? <line x1={left} x2={left + pw} y1={val(v)} y2={val(v)} stroke={th.line} strokeOpacity="0.28" /> : null}<text x={left - 8} y={val(v) + 4} textAnchor="end" fontSize="10.5" fill={th.muted}>{fmt(v)}</text></g>)}</g> : null}
      {spec.type === "bar" || spec.type === "hbar" || spec.type === "stacked" ? bars() : null}
      {spec.type === "line" || spec.type === "area" ? lines() : null}
      {isPie ? pie() : null}
      {spec.type === "scatter" ? scatter() : null}
      {spec.xLabel ? <text x={left + pw / 2} y={H - bottom + 38} textAnchor="middle" fontSize="11.5" fill={th.muted}>{spec.xLabel}</text> : null}
      {spec.yLabel ? <text transform={`translate(14 ${top + ph / 2}) rotate(-90)`} textAnchor="middle" fontSize="11.5" fill={th.muted}>{spec.yLabel}</text> : null}
      {showLegend ? (
        <g transform={`translate(${left} ${H - 18})`}>
          {legendItems.slice(0, 8).map((l, i) => <g key={i} transform={`translate(${i * 84} 0)`}><rect width="10" height="10" y="-9" rx="2" fill={l.color} /><text x="15" fontSize="11" fill={th.text}>{l.name.length > 9 ? l.name.slice(0, 8) + "…" : l.name}</text></g>)}
        </g>
      ) : null}
      {spec.series.length === 0 ? <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="14" fill={th.muted}>No data yet. Add a series.</text> : null}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------ editor */
const TYPES: { id: ChartType; label: string }[] = [{ id: "bar", label: "Bar" }, { id: "hbar", label: "Horizontal bar" }, { id: "stacked", label: "Stacked bar" }, { id: "line", label: "Line" },
  { id: "area", label: "Area" }, { id: "pie", label: "Pie" }, { id: "donut", label: "Donut" }, { id: "scatter", label: "Scatter" }];
const num = (v: string): number | null => { if (v.trim() === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

type Props = { spec: ChartSpec; onChange: (s: ChartSpec) => void; env: Env; docId: string; docName: string };

export function ChartEditor({ spec, onChange, env, docId, docName }: Props) {
  const [sel, setSel] = useState<CSel>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [scatterSeries, setScatterSeries] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const hist = useHistory<ChartSpec>(spec, onChange);
  useEffect(() => { setSel(null); hist.reset(); }, [docId]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (fn: (s: ChartSpec) => void, key?: string) => { const c = structuredClone(spec); fn(c); hist.commit(c, key); };
  const scatter = spec.type === "scatter";
  const isPie = spec.type === "pie" || spec.type === "donut";

  const selection = useMemo<DocSelection | null>(() => {
    if (!sel) return null;
    if (sel.kind === "title") return { docId, docName, kind: "chart", label: "the chart title", text: spec.title };
    const s = spec.series[sel.s];
    if (!s) return null;
    if (sel.kind === "series") return { docId, docName, kind: "chart", label: `series “${s.name}”`, detail: JSON.stringify(s) };
    return scatter
      ? { docId, docName, kind: "chart", label: `point ${sel.i + 1} of “${s.name}”`, detail: JSON.stringify(s.points?.[sel.i]) }
      : { docId, docName, kind: "chart", label: `${isPie ? "slice" : "bar/point"} “${spec.labels[sel.i]}” in “${s.name}” = ${s.values?.[sel.i] ?? "empty"}`, detail: JSON.stringify({ label: spec.labels[sel.i], series: s.name, value: s.values?.[sel.i] }) };
  }, [sel, spec, docId, docName, scatter, isPie]);
  useEffect(() => { env.onSelection(selection); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportAs = async (fmt: "svg" | "png") => {
    setExportOpen(false);
    const el = svgRef.current;
    if (!el) return;
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", "1280"); clone.setAttribute("height", "800");
    const text = new XMLSerializer().serializeToString(clone);
    const base = docName.replace(/\.chart\.json$|\.json$/i, "") || "chart";
    try {
      if (fmt === "svg") await saveBlob(env.download, new Blob([text], { type: "image/svg+xml" }), `${base}.svg`);
      else await saveBlob(env.download, await svgToPng(text, 640, 400, 2, themeOf(env.dark).bg), `${base}.png`);
      env.say(`Exported ${base}.${fmt}`);
    } catch (e) { env.say(e instanceof Error ? e.message : String(e)); }
  };

  const s0 = sel && sel.kind !== "title" ? spec.series[sel.s] : undefined;
  return (
    <div className="dg ch">
      <div className="dg-bar">
        <select value={spec.type} onChange={(e) => patch((s) => { s.type = e.target.value as ChartType; if (s.type === "scatter" && !s.series.every((x) => x.points)) s.series = s.series.map((x) => ({ ...x, points: (x.values ?? []).map((v, i) => ({ x: i + 1, y: v ?? 0 })) })); })} aria-label="Chart type">{TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
        <label className="check"><input type="checkbox" checked={spec.legend} onChange={(e) => patch((s) => { s.legend = e.target.checked; })} /> Legend</label>
        <label className="check"><input type="checkbox" checked={spec.showValues} onChange={(e) => patch((s) => { s.showValues = e.target.checked; })} /> Values</label>
        <label className="check"><input type="checkbox" checked={spec.grid} onChange={(e) => patch((s) => { s.grid = e.target.checked; })} /> Grid</label>
        <button className="icon-btn" title="Undo" disabled={!hist.canUndo} onClick={hist.undo}><Icon name="undo" size={16} /></button>
        <button className="icon-btn" title="Redo" disabled={!hist.canRedo} onClick={hist.redo}><Icon name="redo" size={16} /></button>
        <span className="grow" />
        <div className="menu-wrap">
          <button onClick={() => setExportOpen(!exportOpen)}><Icon name="download" size={14} /> Export</button>
          {exportOpen ? <div className="menu small right" onMouseLeave={() => setExportOpen(false)}><button className="menu-item" onClick={() => void exportAs("svg")}>SVG (vector)</button><button className="menu-item" onClick={() => void exportAs("png")}>PNG (image)</button></div> : null}
        </div>
      </div>
      <div className="dg-main">
        <div className="ch-stage"><ChartView spec={spec} dark={env.dark} sel={sel} onSelect={setSel} svgRef={svgRef} /></div>
        <aside className="dg-side wide">
          <h4>{sel ? (sel.kind === "title" ? "Title" : sel.kind === "series" ? "Series" : isPie ? "Slice" : scatter ? "Point" : "Bar / point") : "Chart"}</h4>
          {!sel ? <div className="muted small">Click a bar, point or slice in the chart to edit it. Edit the data below.</div> : null}
          {sel?.kind === "title" || !sel ? (
            <>
              <label>Title<input value={spec.title} onChange={(e) => patch((s) => { s.title = e.target.value; }, "title")} /></label>
              <label>Subtitle<input value={spec.subtitle} onChange={(e) => patch((s) => { s.subtitle = e.target.value; }, "sub")} /></label>
              {!isPie ? <><label>X axis label<input value={spec.xLabel} onChange={(e) => patch((s) => { s.xLabel = e.target.value; }, "xl")} /></label>
                <label>Y axis label<input value={spec.yLabel} onChange={(e) => patch((s) => { s.yLabel = e.target.value; }, "yl")} /></label></> : null}
            </>
          ) : null}
          {sel?.kind === "point" && s0 ? (
            <>
              {!scatter ? <label>Label<input value={spec.labels[sel.i] ?? ""} onChange={(e) => patch((s) => { s.labels[sel.i] = e.target.value; }, `lab${sel.i}`)} /></label> : null}
              {scatter ? <span className="row"><label>X<input type="number" value={s0.points?.[sel.i]?.x ?? ""} onChange={(e) => patch((s) => { s.series[sel.s].points![sel.i].x = num(e.target.value) ?? 0; }, "px")} /></label>
                <label>Y<input type="number" value={s0.points?.[sel.i]?.y ?? ""} onChange={(e) => patch((s) => { s.series[sel.s].points![sel.i].y = num(e.target.value) ?? 0; }, "py")} /></label></span>
                : <label>Value<input type="number" value={s0.values?.[sel.i] ?? ""} onChange={(e) => patch((s) => { s.series[sel.s].values![sel.i] = num(e.target.value); }, `val${sel.s}:${sel.i}`)} /></label>}
              <label>Colour<span className="row"><input type="color" value={colorOf(spec, sel.s, sel.i)} onChange={(e) => patch((s) => { s.pointColors[`${sel.s}:${sel.i}`] = e.target.value; }, `pc${sel.s}:${sel.i}`)} />
                {spec.pointColors[`${sel.s}:${sel.i}`] ? <button className="link-btn" onClick={() => patch((s) => { delete s.pointColors[`${sel.s}:${sel.i}`]; })}>reset</button> : null}</span></label>
              <button onClick={() => setSel({ kind: "series", s: sel.s })}>Edit whole series</button>
            </>
          ) : null}
          {sel?.kind === "series" && s0 ? (
            <>
              <label>Name<input value={s0.name} onChange={(e) => patch((s) => { s.series[sel.s].name = e.target.value; }, `sn${sel.s}`)} /></label>
              <label>Colour<input type="color" value={colorOf(spec, sel.s)} onChange={(e) => patch((s) => { s.series[sel.s].color = e.target.value; }, `sc${sel.s}`)} /></label>
              <button className="danger" onClick={() => { patch((s) => { s.series.splice(sel.s, 1); }); setSel(null); }}><Icon name="trash" size={14} /> Remove series</button>
            </>
          ) : null}

          <h4>Data</h4>
          {scatter ? (
            <>
              <div className="row">
                <select value={Math.min(scatterSeries, Math.max(0, spec.series.length - 1))} onChange={(e) => setScatterSeries(Number(e.target.value))}>{spec.series.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select>
                <button onClick={() => patch((s) => { s.series.push({ name: `Series ${s.series.length + 1}`, points: [{ x: 1, y: 1 }] }); })}><Icon name="plus" size={13} /> Series</button>
              </div>
              {spec.series[scatterSeries] ? (
                <table className="dg-grid"><thead><tr><th>X</th><th>Y</th><th /></tr></thead><tbody>
                  {(spec.series[scatterSeries].points ?? []).map((p, i) => (
                    <tr key={i} className={sel?.kind === "point" && sel.s === scatterSeries && sel.i === i ? "on" : ""} onClick={() => setSel({ kind: "point", s: scatterSeries, i })}>
                      <td><input type="number" value={p.x} onChange={(e) => patch((s) => { s.series[scatterSeries].points![i].x = num(e.target.value) ?? 0; }, `gx${i}`)} /></td>
                      <td><input type="number" value={p.y} onChange={(e) => patch((s) => { s.series[scatterSeries].points![i].y = num(e.target.value) ?? 0; }, `gy${i}`)} /></td>
                      <td><button className="icon-btn sm" title="Remove point" onClick={() => patch((s) => { s.series[scatterSeries].points!.splice(i, 1); })}><Icon name="x" size={12} /></button></td>
                    </tr>))}
                </tbody></table>
              ) : null}
              <button onClick={() => patch((s) => { (s.series[scatterSeries] ?? (s.series[0] = { name: "Series 1", points: [] })).points!.push({ x: 0, y: 0 }); })}><Icon name="plus" size={13} /> Point</button>
            </>
          ) : (
            <>
              <div className="dg-gridwrap">
                <table className="dg-grid">
                  <thead><tr><th>Label</th>{spec.series.map((s, si) => (
                    <th key={si} className={sel?.kind === "series" && sel.s === si ? "on" : ""}>
                      <input value={s.name} onFocus={() => setSel({ kind: "series", s: si })} onChange={(e) => patch((c) => { c.series[si].name = e.target.value; }, `sn${si}`)} aria-label={`Series ${si + 1} name`} />
                      <button className="icon-btn sm" title="Remove series" onClick={() => patch((c) => { c.series.splice(si, 1); })}><Icon name="x" size={12} /></button>
                    </th>))}<th /></tr></thead>
                  <tbody>
                    {spec.labels.map((l, i) => (
                      <tr key={i}>
                        <td><input value={l} onChange={(e) => patch((c) => { c.labels[i] = e.target.value; }, `lab${i}`)} aria-label={`Row ${i + 1} label`} /></td>
                        {spec.series.map((s, si) => (
                          <td key={si} className={sel?.kind === "point" && sel.s === si && sel.i === i ? "on" : ""}>
                            <input type="number" value={s.values?.[i] ?? ""} onFocus={() => setSel({ kind: "point", s: si, i })} onChange={(e) => patch((c) => { c.series[si].values![i] = num(e.target.value); }, `val${si}:${i}`)} aria-label={`${l} ${s.name}`} />
                          </td>))}
                        <td><button className="icon-btn sm" title="Remove row" onClick={() => patch((c) => { c.labels.splice(i, 1); c.series.forEach((s) => s.values!.splice(i, 1)); })}><Icon name="x" size={12} /></button></td>
                      </tr>))}
                  </tbody>
                </table>
              </div>
              <div className="row">
                <button onClick={() => patch((c) => { c.labels.push(`Item ${c.labels.length + 1}`); c.series.forEach((s) => (s.values ??= []).push(null)); })}><Icon name="plus" size={13} /> Row</button>
                {!isPie ? <button onClick={() => patch((c) => { c.series.push({ name: `Series ${c.series.length + 1}`, values: c.labels.map(() => null), color: PALETTE[c.series.length % PALETTE.length] }); })}><Icon name="plus" size={13} /> Series</button> : null}
              </div>
            </>
          )}
        </aside>
      </div>
      <AskInline env={env} sel={selection} placeholder="Ask the AI to change this chart…" />
    </div>
  );
}
