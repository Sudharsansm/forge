import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { Device, LayerNode, Rect, Sel, Tool } from "../types";

const WIDTH: Record<Device, string> = { desktop: "100%", tablet: "768px", mobile: "390px" };
export type OverlayCtx = { rects: Record<string, Rect>; bounds: { w: number; h: number }; frame: { x: number; y: number; w: number; h: number } };

type Props = {
  html: string | null; device: Device; tool: Tool; selectedSrc: string | null; route: string; tracked: string[];
  blank?: boolean; building: boolean; buildError: string | null; errorTitle: string; frameRef: RefObject<HTMLIFrameElement | null>;
  onSelect: (s: Sel) => void; onTree: (n: LayerNode[]) => void; onRuntimeError: (m: string) => void;
  onTextCommit: (src: string, text: string, changed: boolean) => void; onTextCancel: (src: string, reason?: string) => void;
  onFix: () => void; canFix: boolean; onOpenLink?: (url: string) => void; onRoute?: (path: string) => void;
  overlay: (ctx: OverlayCtx) => ReactNode;
};

export function PreviewPane(p: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [raw, setRaw] = useState<Record<string, Rect>>({});
  const [box, setBox] = useState({ x: 0, y: 0, w: 0, h: 0, fw: 0, fh: 0 });
  const post = useCallback((m: object) => p.frameRef.current?.contentWindow?.postMessage(m, "*"), [p.frameRef]);
  const trackedKey = p.tracked.join("|");

  // where the iframe sits inside the preview, so element rectangles can be placed on top of it
  const measure = useCallback(() => {
    const w = wrapRef.current?.getBoundingClientRect(), f = p.frameRef.current?.getBoundingClientRect();
    if (w && f) setBox((b) => (b.x === f.left - w.left && b.y === f.top - w.top && b.w === w.width && b.h === w.height && b.fw === f.width && b.fh === f.height ? b : { x: f.left - w.left, y: f.top - w.top, w: w.width, h: w.height, fw: f.width, fh: f.height }));
  }, [p.frameRef]);
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [measure, p.html, p.device]);

  useEffect(() => {
    const listener = (e: MessageEvent) => {
      if (e.source !== p.frameRef.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      const d = e.data as { type?: string; payload?: Sel; nodes?: LayerNode[]; message?: string; rects?: Record<string, Rect>; href?: string; path?: string; src?: string; text?: string; changed?: boolean; reason?: string };
      if (d.type === "forge:ready") {
        post({ type: "forge:set-inspect", on: p.tool !== "browse" && p.tool !== "draw" });
        post({ type: "forge:select-src", src: p.selectedSrc });
        post({ type: "forge:track", srcs: p.tracked });
        if (p.route !== "/") post({ type: "forge:navigate", path: p.route });
        post({ type: "forge:get-tree" });
        measure();
      } else if (d.type === "forge:select" && d.payload) p.onSelect(d.payload);
      else if (d.type === "forge:tree" && d.nodes) p.onTree(d.nodes);
      else if (d.type === "forge:rects" && d.rects) { setRaw(d.rects); measure(); }
      else if (d.type === "forge:text-commit" && d.src) p.onTextCommit(d.src, d.text ?? "", Boolean(d.changed));
      else if (d.type === "forge:text-cancel" && d.src) p.onTextCancel(d.src, d.reason);
      else if (d.type === "forge:route" && typeof d.path === "string" && d.path.startsWith("/")) p.onRoute?.(d.path);
      else if (d.type === "forge:link" && d.href && /^(https?:|mailto:|tel:)/i.test(d.href)) p.onOpenLink?.(d.href);
      else if (d.type === "forge:error" && d.message) p.onRuntimeError(d.message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  });

  useEffect(() => { post({ type: "forge:set-inspect", on: p.tool !== "browse" && p.tool !== "draw" }); }, [p.tool, post]);
  useEffect(() => { post({ type: "forge:select-src", src: p.selectedSrc }); }, [p.selectedSrc, post]);
  useEffect(() => { post({ type: "forge:track", srcs: p.tracked }); }, [trackedKey, post]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { post({ type: "forge:navigate", path: p.route }); }, [p.route, post]);

  if (p.blank) return <div className="preview-empty" />; // nothing generated yet: an empty page
  if (!p.html) {
    return (
      <div className="preview-empty">
        {p.buildError ? (
          <div className="build-error">
            <b>{p.errorTitle}</b>
            <pre>{p.buildError}</pre>
            {p.canFix ? <button className="primary" onClick={p.onFix}>Ask the AI to fix it</button> : null}
          </div>
        ) : (
          <div className="loading"><div className="spinner" /><span>{p.building ? "Building preview…" : "Waiting for an app to preview"}</span></div>
        )}
      </div>
    );
  }
  const rects: Record<string, Rect> = {};
  for (const [k, r] of Object.entries(raw)) rects[k] = { x: r.x + box.x, y: r.y + box.y, w: r.w, h: r.h };
  return (
    <div className="preview-wrap" ref={wrapRef}>
      <div className="frame-stage">
        <iframe ref={p.frameRef} title="App preview" sandbox="allow-scripts allow-forms" srcDoc={p.html}
          className={p.device === "desktop" ? "" : "framed"} style={{ width: WIDTH[p.device] }} />
      </div>
      <div className="overlay">{p.overlay({ rects, bounds: { w: box.w, h: box.h }, frame: { x: box.x, y: box.y, w: box.fw, h: box.fh } })}</div>
      {p.building ? <div className="badge building"><div className="spinner sm" /> Updating…</div> : null}
      {p.buildError ? (
        <div className="build-error banner">
          <b>{p.errorTitle}</b>
          <pre>{p.buildError}</pre>
          {p.canFix ? <button className="primary" onClick={p.onFix}>Ask the AI to fix it</button> : null}
        </div>
      ) : null}
    </div>
  );
}
