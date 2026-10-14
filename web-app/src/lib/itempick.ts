/** Which part of a generated file (document, image, chart, slide, table…) a click means. Pure DOM helpers, no React. */
const PICK = [".blk", ".blk-img", ".blk-table", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "blockquote", "img", "canvas", "video", "audio",
  "svg text", "svg rect", "svg circle", "svg ellipse", "svg path", "svg polygon", "svg line", ".nb-cell", ".arc-row", ".gc", ".slide", "a", "button"].join(",");

export function pickTarget(t: EventTarget | null, host: HTMLElement, skip?: Element | null): HTMLElement | null {
  const el = t instanceof Element ? t : null;
  if (!el || (skip && skip.contains(el))) return null;
  const hit = el.closest(PICK) as HTMLElement | null;
  if (hit && host.contains(hit) && hit !== host) return hit;
  return host.contains(el) && el !== host ? (el as HTMLElement) : null;
}

export function describeEl(el: Element): { tag: string; text: string } {
  const tag = el.tagName.toLowerCase();
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const text = (raw.trim() || el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").slice(0, 120);
  return { tag, text };
}
