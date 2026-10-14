import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { CommentLayer } from "./CommentLayer";
import { Composer } from "./Composer";
import { DrawLayer } from "./DrawLayer";
import { buildPrompt, probePoints, renderWireframe } from "../lib/annotate";
import type { Hit, Stroke } from "../lib/annotate";
import { describeEl, pickTarget } from "../lib/itempick";
import type { Env } from "./docs/env";
import type { Comment, DocSelection, Rect, Sel, Tool } from "../types";

type Doc = { id: string; name: string; kind: string };
type Props = { host: RefObject<HTMLElement | null>; tool: Tool; env: Env; doc: Doc; project: string; sendLabel: string; busy: boolean; onExit: () => void };

const rectOf = (el: Element, host: HTMLElement): Rect => { const r = el.getBoundingClientRect(), b = host.getBoundingClientRect(); return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height }; };
const same = (a?: Rect, b?: Rect) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * The same four tools as on the app preview, for whatever Claude generated (document, image, chart, slides, table…):
 * Select (hover + click a part), Text (the file itself becomes the editor, so this layer steps aside), Draw, Comment.
 */
export function ItemLayer({ host, tool, env, doc, project, sendLabel, busy, onExit }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const seq = useRef(0);
  const [hover, setHover] = useState<{ rect: Rect; label: string } | null>(null);
  const [picked, setPicked] = useState<{ src: string; sel: Sel } | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState<Sel | null>(null);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [bounds, setBounds] = useState({ w: 0, h: 0 });

  const makeSel = (el: HTMLElement, e: MouseEvent): Sel => {
    const { tag, text } = describeEl(el);
    const src = `item:${++seq.current}`;
    els.current.set(src, el);
    const r = el.getBoundingClientRect();
    return { src, path: doc.name, line: 0, col: 0, tag, className: "", text: text || null, styles: { color: "", backgroundColor: "", fontSize: "", fontWeight: "", padding: "" },
      rect: { width: r.width, height: r.height }, click: { fx: r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5, fy: r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0.5 } };
  };
  const docSel = (s: Sel): DocSelection => ({ docId: doc.id, docName: doc.name, kind: doc.kind as DocSelection["kind"], label: `<${s.tag}>${s.text ? ` “${s.text.slice(0, 40)}”` : ""}`, text: s.text ?? undefined, detail: `${s.tag} element` });

  // Select / Comment: hover outline, click picks (and keeps the file's own editor from reacting)
  useEffect(() => {
    const h = host.current;
    if (!h || (tool !== "select" && tool !== "comment")) { setHover(null); return; }
    const target = (e: Event) => pickTarget(e.target, h, root.current);
    const inLayer = (e: Event) => !!root.current && root.current.contains(e.target as Node);
    const move = (e: MouseEvent) => { if (inLayer(e)) return; const el = target(e); setHover(el ? { rect: rectOf(el, h), label: el.tagName.toLowerCase() } : null); };
    const click = (e: MouseEvent) => {
      if (inLayer(e)) return;
      const el = target(e); if (!el) return;
      e.preventDefault(); e.stopPropagation();
      const s = makeSel(el, e);
      if (tool === "select") { setPicked({ src: s.src, sel: s }); setDraft(null); env.onSelection(docSel(s)); env.postChip?.(s.tag, `The user selected <${s.tag}>${s.text ? ` “${s.text}”` : ""} in document "${doc.name}" (id ${doc.id}, ${doc.kind}) of Forge project "${project}".`); }
      else { setDraft(s); setPicked(null); }
    };
    const block = (e: Event) => { if (!inLayer(e) && target(e)) { e.preventDefault(); e.stopPropagation(); } };
    h.addEventListener("mousemove", move, true); h.addEventListener("click", click, true);
    for (const n of ["mousedown", "pointerdown", "dblclick", "contextmenu"]) h.addEventListener(n, block, true);
    h.style.cursor = "crosshair";
    return () => {
      h.removeEventListener("mousemove", move, true); h.removeEventListener("click", click, true);
      for (const n of ["mousedown", "pointerdown", "dblclick", "contextmenu"]) h.removeEventListener(n, block, true);
      h.style.cursor = ""; setHover(null);
    };
  }, [tool, host, doc.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // leaving Select clears the pick; another file clears everything
  useEffect(() => { if (tool !== "select") setPicked(null); if (tool !== "comment") setDraft(null); }, [tool]);
  useEffect(() => { setPicked(null); setDraft(null); setComments([]); els.current.clear(); env.onSelection(null); }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep outlines, pins and popovers on their parts while the file scrolls or re-renders
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const h = host.current;
      if (h) {
        const b = h.getBoundingClientRect();
        setBounds((o) => (o.w === b.width && o.h === b.height ? o : { w: b.width, h: b.height }));
        const next: Record<string, Rect> = {};
        const keys = [picked?.src, draft?.src, ...comments.map((c) => c.sel.src)].filter(Boolean) as string[];
        for (const k of keys) { const el = els.current.get(k); if (el && el.isConnected) next[k] = rectOf(el, h); }
        setRects((o) => { const ks = Object.keys(next); return ks.length === Object.keys(o).length && ks.every((k) => same(o[k], next[k])) ? o : next; });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [picked?.src, draft?.src, comments, host]);

  const sendComments = () => {
    void env.post?.([`[Forge review comments] Project "${project}", document "${doc.name}" (id ${doc.id}, ${doc.kind}). Please address each:`,
      ...comments.map((c, i) => `${i + 1}. <${c.sel.tag}>${c.sel.text ? ` “${c.sel.text.slice(0, 80)}”` : ""}: ${c.text}`),
      "Apply them with forge_replace_in_document or forge_update_document."].join("\n")).then((ok) => { if (ok) setComments([]); });
  };

  const sendDrawing = async (instruction: string, drawn: Stroke[], frame: { x: number; y: number; w: number; h: number }) => {
    const h = host.current;
    if (!h || !env.post) return false;
    const b = h.getBoundingClientRect();
    const local = drawn.map((s) => s.map((p) => ({ x: p.x - frame.x, y: p.y - frame.y })));
    const hits: Hit[][] = local.map(() => []);
    probePoints(local).forEach((pt) => {
      const stack = document.elementsFromPoint(b.left + pt.x, b.top + pt.y);
      for (const raw of stack) {
        const el = pickTarget(raw, h, root.current);
        if (!el) continue;
        const d = describeEl(el), r = rectOf(el, h), key = `${d.tag}|${d.text}|${Math.round(r.x)}|${Math.round(r.y)}`;
        if (!hits[pt.s].some((x) => x.src === key)) hits[pt.s].push({ src: key, path: doc.name, line: 0, tag: d.tag, text: d.text, rect: r });
        break;
      }
    });
    hits.forEach((list) => list.sort((p, q) => p.rect.w * p.rect.h - q.rect.w * q.rect.h));
    const vw = Math.round(b.width), vh = Math.round(b.height);
    const text = buildPrompt({ project, route: "/", device: "desktop", vw, vh, strokes: local, hits, instruction: instruction || "(The user will say what to change in their next chat message.)", doc });
    const png = renderWireframe(vw, vh, hits, local);
    if (env.hostChat) { // like Select: a short marker in the host chat box, details as model context
      const first = hits.flat().sort((p, q) => p.rect.w * p.rect.h - q.rect.w * q.rect.h)[0];
      env.setContext?.(`The user drew on document "${doc.name}". A token like "✎ tag" in their next message refers to it. Change nothing until they say what to change.\n${text}`);
      return env.post(`✎ ${first?.tag ?? "drawing"} `, png ? [{ mimeType: "image/png", base64: png }] : undefined);
    }
    return env.post(text, png ? [{ mimeType: "image/png", base64: png }] : undefined);
  };

  return (
    <div className="overlay ilayer" ref={root}>
      {hover && (tool === "select" || tool === "comment") ? <div className="sel-box hover" style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.w, height: hover.rect.h }}><span className="sel-tag">&lt;{hover.label}&gt;</span></div> : null}
      {picked && rects[picked.src] ? <div className="sel-box on" style={{ left: rects[picked.src].x, top: rects[picked.src].y, width: rects[picked.src].w, height: rects[picked.src].h }}><span className="sel-tag">&lt;{picked.sel.tag}&gt;</span></div> : null}
      {tool === "select" && picked && !env.hostChat ? (
        <Composer key={picked.src} sel={picked.sel} sendLabel={sendLabel} busy={busy} onSend={(t) => env.ask(t, docSel(picked.sel))} onClear={() => { setPicked(null); env.onSelection(null); }} onEscape={onExit} />
      ) : null}
      {tool === "select" && picked && env.hostChat ? <Composer key={picked.src} hostChat sel={picked.sel} sendLabel={sendLabel} busy={busy} onSend={() => undefined} onClear={() => { setPicked(null); env.onSelection(null); }} onEscape={onExit} /> : null}
      {tool === "comment" || comments.length ? (
        <CommentLayer comments={comments} rects={rects} bounds={bounds} draft={tool === "comment" ? draft : null} sendLabel={sendLabel}
          onAdd={(t) => { if (draft) { setComments((cs) => [...cs, { id: Date.now(), sel: draft, text: t }]); setDraft(null); env.say("Comment added"); } }}
          onCancel={() => setDraft(null)} onDelete={(id) => setComments((cs) => cs.filter((c) => c.id !== id))} onSend={sendComments} onClear={() => setComments([])} />
      ) : null}
      {tool === "draw" ? <DrawLayer key={doc.id} hostChat={env.hostChat} frame={{ x: 0, y: 0, w: bounds.w, h: bounds.h }} sendLabel={sendLabel} busy={busy} onSend={sendDrawing} onExit={onExit} /> : null}
    </div>
  );
}
