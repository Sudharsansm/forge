/** Pure helpers for the Draw tool: turn freehand marks into something Claude can act on. */
export type Pt = { x: number; y: number };
export type Stroke = Pt[];
export type Rect = { x: number; y: number; w: number; h: number };
export type Hit = { src: string; path: string; line: number; tag: string; text: string; rect: Rect };
export type ProbePoint = Pt & { s: number };

export function bbox(s: Stroke): Rect {
  const xs = s.map((p) => p.x), ys = s.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const pathLen = (s: Stroke) => s.reduce((n, p, i) => (i ? n + dist(s[i - 1], p) : 0), 0);

/** What the mark looks like: a circle/loop around something, a straight line or arrow, or a freehand scribble. */
export function shapeOf(s: Stroke): "circled area" | "line or arrow" | "freehand mark" {
  if (s.length < 3) return "freehand mark";
  const b = bbox(s), diag = Math.hypot(b.w, b.h) || 1;
  if (dist(s[0], s[s.length - 1]) < diag * 0.3 && pathLen(s) > diag * 1.6) return "circled area";
  if (pathLen(s) < dist(s[0], s[s.length - 1]) * 1.25) return "line or arrow";
  return "freehand mark";
}

/** Points to ask the page "which element is here?": along each stroke, plus a 3x3 grid over its bounding box. */
export function probePoints(strokes: Stroke[], max = 60): ProbePoint[] {
  const out: ProbePoint[] = [];
  strokes.forEach((s, si) => {
    if (!s.length) return;
    const step = Math.max(1, Math.floor(s.length / 14));
    for (let i = 0; i < s.length; i += step) out.push({ ...s[i], s: si });
    const b = bbox(s);
    for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.15, 0.5, 0.85]) out.push({ x: b.x + b.w * fx, y: b.y + b.h * fy, s: si });
  });
  return out.slice(0, max);
}

const pct = (v: number, of: number) => `${Math.round((v / (of || 1)) * 100)}%`;

export function buildPrompt(o: { project: string; route: string; device: string; vw: number; vh: number; strokes: Stroke[]; hits: Hit[][]; instruction: string; doc?: { id: string; name: string; kind: string } }): string {
  const lines = [
    o.doc ? `[Forge drawing annotation] Project "${o.project}", document "${o.doc.name}" (id ${o.doc.id}, ${o.doc.kind}), preview (${o.vw}x${o.vh}).`
          : `[Forge drawing annotation] Project "${o.project}", page "${o.route}", ${o.device} preview (${o.vw}x${o.vh}).`,
    `The user drew ${o.strokes.length} mark${o.strokes.length === 1 ? "" : "s"} on the preview. Each mark lists the elements under it, innermost first.`,
  ];
  o.strokes.forEach((s, i) => {
    const b = bbox(s);
    lines.push(`Mark ${i + 1}: ${shapeOf(s)} at x ${pct(b.x, o.vw)}, y ${pct(b.y, o.vh)}, ${pct(b.w, o.vw)} wide, ${pct(b.h, o.vh)} tall.`);
    const hits = o.hits[i] ?? [];
    if (!hits.length) lines.push("  (no element could be identified under this mark: use its position)");
    hits.slice(0, 6).forEach((h) => lines.push(`  - <${h.tag}>${h.text ? ` “${h.text.slice(0, 60)}”` : ""}${o.doc ? "" : ` at ${h.path}:${h.line}`}`));
  });
  lines.push(`Request: ${o.instruction}`);
  lines.push(o.doc ? "Apply it with forge_replace_in_document for a small change, or forge_update_document for a larger one (read it first with forge_library_read). Keep everything else unchanged."
                   : "Make the change with the Forge tools (forge_write_files, or update_component for one element). Keep everything else unchanged.");
  return lines.join("\n");
}

/** A small wireframe of the page: the elements the marks touch (outlined, labelled) with the marks drawn on top. */
export function renderWireframe(vw: number, vh: number, hits: Hit[][], strokes: Stroke[]): string | null {
  try {
    const scale = Math.min(1, 720 / (vw || 720));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(vw * scale)); c.height = Math.max(1, Math.round(vh * scale));
    const g = c.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#cbd5e1"; g.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
    const seen = new Set<string>();
    g.font = "11px sans-serif"; g.lineWidth = 1.5;
    hits.flat().forEach((h) => {
      if (seen.has(h.src)) return; seen.add(h.src);
      g.strokeStyle = "#2563eb"; g.strokeRect(h.rect.x * scale, h.rect.y * scale, h.rect.w * scale, h.rect.h * scale);
      g.fillStyle = "#2563eb"; g.fillText(`<${h.tag}>${h.text ? " " + h.text.slice(0, 24) : ""}`, h.rect.x * scale + 3, h.rect.y * scale + 12);
    });
    g.strokeStyle = "#ef4444"; g.lineWidth = 3; g.lineCap = "round"; g.lineJoin = "round";
    strokes.forEach((s) => { g.beginPath(); s.forEach((p, i) => (i ? g.lineTo(p.x * scale, p.y * scale) : g.moveTo(p.x * scale, p.y * scale))); g.stroke(); });
    return c.toDataURL("image/png").split(",")[1] ?? null;
  } catch { return null; }
}
