/** Copy text to the clipboard. Sandboxed iframes may block the async API, so fall back to execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/* ---------------------------------------------------------------- fuzzy search (VS Code style) */
export type Fuzzy = { score: number; positions: number[] };
const BOUNDARY = new Set(["/", "-", "_", ".", " "]);
const range = (start: number, len: number) => Array.from({ length: len }, (_, i) => start + i);

/** Match `query` against `text` the way VS Code's quick open does: substring first, otherwise an in-order subsequence. */
export function fuzzy(query: string, text: string): Fuzzy | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const base = text.lastIndexOf("/") + 1;
  let i = t.indexOf(q, base);
  if (i !== -1) return { score: 1000 - (i - base) - text.length / 20, positions: range(i, q.length) };
  i = t.indexOf(q);
  if (i !== -1) return { score: 800 - i - text.length / 20, positions: range(i, q.length) };
  const positions: number[] = [];
  let ti = 0, score = 0, prev = -2;
  for (const ch of q) {
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== ch) continue;
      if (found === -1) found = k;
      if (k === prev + 1 || k === 0 || BOUNDARY.has(t[k - 1]) || (text[k] !== t[k] && text[k - 1] === t[k - 1])) { found = k; break; }
      if (k - ti > 12) break; // do not skip far ahead just to reach a boundary
    }
    if (found === -1) return null;
    score += found === prev + 1 ? 15 : 0;
    score += found === 0 || BOUNDARY.has(t[found - 1]) ? 10 : 0;
    score += found >= base ? 3 : 0;
    score -= Math.min(found - ti, 20) * 0.5;
    positions.push(found);
    prev = found; ti = found + 1;
  }
  return { score: score + 100 - text.length / 20, positions };
}

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const isDotfile = (path: string) => fileName(path).startsWith(".") && fileName(path).lastIndexOf(".") === 0;
export const extOf = (path: string) => (!isDotfile(path) && fileName(path).includes(".") ? fileName(path).split(".").pop()!.toLowerCase() : "");

/** Look of a file in the Files tab (badge colour + readable type), like the file cards in Claude. */
export const FILE_KINDS: Record<string, { label: string; color: string; text: boolean }> = {
  tsx: { label: "TypeScript React", color: "#2f74c0", text: true }, ts: { label: "TypeScript", color: "#3178c6", text: true },
  jsx: { label: "JavaScript React", color: "#d9a300", text: true }, js: { label: "JavaScript", color: "#d9a300", text: true },
  mjs: { label: "JavaScript module", color: "#d9a300", text: true }, css: { label: "Stylesheet", color: "#8b5cf6", text: true },
  html: { label: "HTML document", color: "#e44d26", text: true }, json: { label: "JSON data", color: "#64748b", text: true },
  md: { label: "Markdown", color: "#0ea5e9", text: true }, svg: { label: "SVG image", color: "#f97316", text: true },
  png: { label: "PNG image", color: "#10b981", text: false }, jpg: { label: "JPEG image", color: "#10b981", text: false },
  jpeg: { label: "JPEG image", color: "#10b981", text: false }, gif: { label: "GIF image", color: "#10b981", text: false },
  webp: { label: "WebP image", color: "#10b981", text: false }, ico: { label: "Icon", color: "#10b981", text: false },
};
export const kindOf = (path: string) => (isDotfile(path) ? { label: "Config file", color: "#94a3b8", text: true } : FILE_KINDS[extOf(path)]) ?? { label: extOf(path) ? `${extOf(path).toUpperCase()} file` : "Text file", color: "#94a3b8", text: true };
