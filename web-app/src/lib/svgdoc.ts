/** Client-side SVG safety (the server sanitises too): no scripts, no foreignObject, no handlers, no external references. */
const ALLOWED = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "use", "image", "title", "desc", "marker", "symbol", "style", "filter", "fegaussianblur", "feoffset", "fecolormatrix", "feblend", "femerge", "femergenode", "feflood", "fecomposite", "fedropshadow", "textpath"]);

export function cleanCss(css: string): string {
  return css.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(?!['"]?(?:#|data:image\/))[^)]*\)/gi, "none");
}

function scrub(el: Element) {
  for (const child of [...el.children]) {
    if (!ALLOWED.has(child.tagName.toLowerCase())) { child.remove(); continue; }
    scrub(child);
  }
  for (const a of [...el.attributes]) {
    const name = a.name.toLowerCase(), v = a.value;
    if (name.startsWith("on") || name === "srcdoc") el.removeAttribute(a.name);
    else if (name === "href" || name === "xlink:href") { if (!(v.startsWith("#") || /^data:image\/(png|jpe?g|gif|webp);/.test(v))) el.removeAttribute(a.name); }
    else if (name === "style") el.setAttribute("style", cleanCss(v));
    else if (/javascript:|expression\(/i.test(v)) el.removeAttribute(a.name);
  }
  if (el.tagName.toLowerCase() === "style" && el.textContent) el.textContent = cleanCss(el.textContent);
}

export function parseSvg(text: string): SVGSVGElement | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
  scrub(root);
  return root as unknown as SVGSVGElement;
}

export const serializeSvg = (el: Element): string => {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("[data-forge-sel]").forEach((n) => n.removeAttribute("data-forge-sel"));
  if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(clone);
};

/** Rasterise SVG text to a PNG blob. */
export function svgToPng(svg: string, width: number, height: number, scale = 2, background?: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(width * scale); c.height = Math.round(height * scale);
      const ctx = c.getContext("2d")!;
      if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not create the image"))), "image/png");
    };
    img.onerror = () => reject(new Error("Could not render the SVG"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(blob);
  });
}

export function saveBlob(bridgeDownload: (f: { filename: string; mimeType: string; base64: string }) => Promise<void>, blob: Blob, filename: string) {
  return blobToBase64(blob).then((base64) => bridgeDownload({ filename, mimeType: blob.type || "application/octet-stream", base64 }));
}
