import type { ChartSpec } from "../types";

export const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
export const colorOf = (spec: ChartSpec, s: number, i?: number): string =>
  (i !== undefined && spec.pointColors[`${s}:${i}`]) || spec.series[s]?.color || PALETTE[s % PALETTE.length];

/** "Nice" axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): { ticks: number[]; lo: number; hi: number } {
  if (!isFinite(min) || !isFinite(max)) return { ticks: [0, 1], lo: 0, hi: 1 };
  if (min === max) { max = min + 1; if (min > 0) min = 0; }
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { ticks, lo, hi };
}

export const fmt = (v: number): string => (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e4 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`);

export function arc(cx: number, cy: number, r: number, r0: number, a0: number, a1: number): string {
  const p = (rad: number, a: number) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(r, a0), [x1, y1] = p(r, a1);
  if (r0 <= 0) return `M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`;
  const [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
  return `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`;
}

/** Values of a series with nulls treated as gaps. */
export const vals = (spec: ChartSpec, s: number): (number | null)[] => spec.series[s]?.values ?? [];

export function dataRange(spec: ChartSpec): { min: number; max: number } {
  if (spec.type === "scatter") {
    const ys = spec.series.flatMap((s) => (s.points ?? []).map((p) => p.y));
    return { min: Math.min(0, ...ys), max: Math.max(1, ...ys) };
  }
  if (spec.type === "stacked") {
    const n = spec.labels.length;
    let max = 0, min = 0;
    for (let i = 0; i < n; i++) {
      let pos = 0, neg = 0;
      spec.series.forEach((_, s) => { const v = vals(spec, s)[i] ?? 0; if (v >= 0) pos += v; else neg += v; });
      max = Math.max(max, pos); min = Math.min(min, neg);
    }
    return { min, max: max || 1 };
  }
  const all = spec.series.flatMap((_, s) => vals(spec, s).filter((v): v is number => v !== null));
  return { min: Math.min(0, ...all), max: Math.max(1, ...all, 0) };
}
