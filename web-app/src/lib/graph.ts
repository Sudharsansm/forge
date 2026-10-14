import type { GraphSpec, GNode, SeqSpec } from "../types";

export type Box = { x: number; y: number; w: number; h: number };
export type GraphLayout = {
  nodes: Record<string, Box>;
  edges: { id: string; from: string; to: string; d: string; lx: number; ly: number; label?: string; dashed?: boolean; back: boolean }[];
  lanes: { id: string; label: string; x: number; y: number; w: number; h: number }[];
  width: number; height: number;
};

const GAP_RANK = 90, GAP_NODE = 26, PAD = 40, LANE_PAD = 18;

export function nodeSize(n: GNode): { w: number; h: number } {
  const w = Math.max(112, Math.min(230, Math.max(n.label.length * 7.2, (n.sub?.length ?? 0) * 5.8) + 34));
  return { w, h: n.sub ? 50 : 36 };
}

/** Layer assignment: the node's group when the spec has groups, otherwise the longest path from a source (cycles ignored). */
export function ranks(spec: GraphSpec): Record<string, number> {
  const groupIndex = new Map((spec.groups ?? []).map((g, i) => [g.id, i]));
  const out: Record<string, number> = {};
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of spec.nodes) { adj.set(n.id, []); indeg.set(n.id, 0); }
  // drop back edges found by DFS so the longest-path pass terminates
  const state = new Map<string, 0 | 1 | 2>();
  const out2 = new Map<string, string[]>();
  for (const e of spec.edges) { if (adj.has(e.from) && adj.has(e.to)) (out2.get(e.from) ?? out2.set(e.from, []).get(e.from)!).push(e.to); }
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out2.get(id) ?? []) {
      const s = state.get(t) ?? 0;
      if (s === 1) continue;                     // back edge
      adj.get(id)!.push(t); indeg.set(t, indeg.get(t)! + 1);
      if (s === 0) visit(t);
    }
    state.set(id, 2);
  };
  for (const n of spec.nodes) if (!state.get(n.id)) visit(n.id);
  const queue = spec.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const depth: Record<string, number> = Object.fromEntries(queue.map((id) => [id, 0]));
  const left = new Map(indeg);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of adj.get(id) ?? []) {
      depth[t] = Math.max(depth[t] ?? 0, (depth[id] ?? 0) + 1);
      left.set(t, left.get(t)! - 1);
      if (left.get(t) === 0) queue.push(t);
    }
  }
  for (const n of spec.nodes) out[n.id] = n.group !== undefined && groupIndex.has(n.group) ? groupIndex.get(n.group)! : depth[n.id] ?? 0;
  return out;
}

export function layoutGraph(spec: GraphSpec): GraphLayout {
  const TB = spec.direction === "TB";
  const r = ranks(spec);
  const sizes = Object.fromEntries(spec.nodes.map((n) => [n.id, nodeSize(n)]));
  const rankIds = [...new Set(Object.values(r))].sort((a, b) => a - b);
  const columns = new Map<number, string[]>(rankIds.map((k) => [k, spec.nodes.filter((n) => r[n.id] === k).map((n) => n.id)]));
  // order within a column by the average position of neighbours (a few sweeps reduce crossings)
  const pos: Record<string, number> = {};
  columns.forEach((ids) => ids.forEach((id, i) => { pos[id] = i; }));
  const nb = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
  for (const e of spec.edges) { nb.get(e.from)?.push(e.to); nb.get(e.to)?.push(e.from); }
  for (let pass = 0; pass < 4; pass++) {
    const seq = pass % 2 ? [...rankIds].reverse() : rankIds;
    for (const k of seq) {
      const ids = columns.get(k)!;
      const bary = (id: string) => { const ns = (nb.get(id) ?? []).filter((x) => r[x] !== k); return ns.length ? ns.reduce((s, x) => s + pos[x], 0) / ns.length : pos[id]; };
      ids.sort((a, b) => bary(a) - bary(b));
      ids.forEach((id, i) => { pos[id] = i; });
    }
  }
  const major: Record<number, number> = {};   // size of each rank along the flow direction
  const minorTotal: Record<number, number> = {};
  for (const k of rankIds) {
    const ids = columns.get(k)!;
    major[k] = Math.max(...ids.map((id) => (TB ? sizes[id].h : sizes[id].w)), 0);
    minorTotal[k] = ids.reduce((s, id) => s + (TB ? sizes[id].w : sizes[id].h) + GAP_NODE, -GAP_NODE);
  }
  const maxMinor = Math.max(...Object.values(minorTotal), 0);
  const boxes: Record<string, Box> = {};
  let cursor = PAD + LANE_PAD;
  for (const k of rankIds) {
    const ids = columns.get(k)!;
    let m = PAD + LANE_PAD + (maxMinor - minorTotal[k]) / 2;
    for (const id of ids) {
      const { w, h } = sizes[id];
      boxes[id] = TB ? { x: m, y: cursor + (major[k] - h) / 2, w, h } : { x: cursor + (major[k] - w) / 2, y: m, w, h };
      m += (TB ? w : h) + GAP_NODE;
    }
    cursor += major[k] + GAP_RANK;
  }
  for (const n of spec.nodes) {  // hand-placed nodes keep their position
    if (n.x !== undefined && n.y !== undefined) boxes[n.id] = { ...boxes[n.id], x: n.x, y: n.y };
  }
  const lanes: GraphLayout["lanes"] = [];
  for (const g of spec.groups ?? []) {
    const members = spec.nodes.filter((n) => n.group === g.id).map((n) => boxes[n.id]);
    if (!members.length) continue;
    const x0 = Math.min(...members.map((b) => b.x)) - LANE_PAD, y0 = Math.min(...members.map((b) => b.y)) - LANE_PAD - 18;
    const x1 = Math.max(...members.map((b) => b.x + b.w)) + LANE_PAD, y1 = Math.max(...members.map((b) => b.y + b.h)) + LANE_PAD;
    lanes.push({ id: g.id, label: g.label, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  const edges = spec.edges.filter((e) => boxes[e.from] && boxes[e.to]).map((e) => {
    const a = boxes[e.from], b = boxes[e.to];
    const back = TB ? b.y + b.h / 2 <= a.y + a.h / 2 : b.x + b.w / 2 <= a.x + a.w / 2;
    let d: string, lx: number, ly: number;
    if (!back) {
      if (TB) { const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2; d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = my; }
      else { const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2; d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; lx = mx; ly = (y1 + y2) / 2; }
    } else {  // loop around below / to the right
      if (TB) { const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2, o = Math.max(x1, x2) + 60; d = `M${x1},${y1} C${o},${y1} ${o},${y2} ${x2},${y2}`; lx = o - 6; ly = (y1 + y2) / 2; }
      else { const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y + b.h, o = Math.max(y1, y2) + 46; d = `M${x1},${y1} C${x1},${o} ${x2},${o} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = o - 8; }
    }
    return { id: e.id, from: e.from, to: e.to, d, lx, ly, label: e.label, dashed: e.dashed, back };
  });
  const all = Object.values(boxes);
  const width = Math.max(320, ...all.map((b) => b.x + b.w), ...lanes.map((l) => l.x + l.w)) + PAD;
  const height = Math.max(200, ...all.map((b) => b.y + b.h), ...lanes.map((l) => l.y + l.h)) + PAD + 40;
  return { nodes: boxes, edges, lanes, width, height };
}

/* ------------------------------------------------------------------ sequence */
export type SeqLayout = {
  parts: { id: string; label: string; kind: string; x: number; w: number; color?: string }[];
  msgs: { id: string; kind: string; label: string; x1: number; x2: number; y: number; self: boolean; phase?: string; from: string; to: string }[];
  width: number; height: number; headH: number;
};
export function layoutSequence(spec: SeqSpec): SeqLayout {
  const colW = 160, headH = 46, top = 24, rowH = 46;
  const parts = spec.participants.map((p, i) => ({ id: p.id, label: p.label, kind: p.kind, x: 70 + i * colW, w: Math.min(colW - 24, Math.max(96, p.label.length * 7.5 + 26)), color: p.color }));
  const xOf = Object.fromEntries(parts.map((p) => [p.id, p.x]));
  let y = top + headH + 34;
  const msgs = spec.messages.map((m) => {
    const self = m.kind === "self" || m.from === m.to;
    const note = m.kind === "note";
    const row = { id: m.id, kind: m.kind, label: m.label, x1: xOf[m.from] ?? 0, x2: xOf[m.to] ?? 0, y, self: self && !note, phase: m.phase, from: m.from, to: m.to };
    y += self && !note ? rowH + 14 : note ? 40 : rowH;
    return row;
  });
  return { parts, msgs, width: Math.max(360, 70 + parts.length * colW), height: y + 30, headH };
}
