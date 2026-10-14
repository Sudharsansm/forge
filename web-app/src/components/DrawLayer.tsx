import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Stroke } from "../lib/annotate";

type Props = {
  frame: { x: number; y: number; w: number; h: number };
  sendLabel: string; busy: boolean; hostChat?: boolean;
  onSend: (instruction: string, strokes: Stroke[], frame: { x: number; y: number; w: number; h: number }) => Promise<boolean>;
  onExit: () => void;
};

/** Draw annotation, like Lovable's pencil: draw on the preview, say what to change, send it with the marked elements. */
export function DrawLayer({ frame, sendLabel, busy, hostChat, onSend, onExit }: Props) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [text, setText] = useState("");
  const cur = useRef<Stroke | null>(null);
  const [, tick] = useState(0);
  const svg = useRef<SVGSVGElement>(null);

  const pt = (e: React.PointerEvent) => { const r = svg.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => { svg.current?.setPointerCapture(e.pointerId); cur.current = [pt(e)]; tick((n) => n + 1); };
  const move = (e: React.PointerEvent) => { if (cur.current) { cur.current.push(pt(e)); tick((n) => n + 1); } };
  const up = () => { const s = cur.current; cur.current = null; if (s && s.length > 1) setStrokes((a) => [...a, s]); tick((n) => n + 1); };
  const d = (s: Stroke) => s.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const send = async () => {
    if (!text.trim() || !strokes.length || busy) return;
    if (await onSend(text.trim(), strokes, frame)) { setStrokes([]); setText(""); }
  };

  // Inside an AI app the marks go straight to the host chat (like Select does): no box of our own, the user types in the chat.
  const [posted, setPosted] = useState(0);
  useEffect(() => {
    if (!hostChat || !strokes.length) return;
    const id = setTimeout(() => { void onSend("", strokes, frame).then((ok) => { if (ok) setPosted(strokes.length); }); }, 1500); // wait until the user stops drawing, so the chat box is updated once
    return () => clearTimeout(id);
  }, [strokes]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <svg ref={svg} className="drawlayer" aria-label="Drawing surface" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {strokes.map((s, i) => <path key={i} d={d(s)} />)}
        {cur.current ? <path d={d(cur.current)} /> : null}
      </svg>
      <div className="composer drawbar" role="group" aria-label="Draw annotation">
        <div className="cchips">
          <span className="cchip"><Icon name="pencil" size={13} /> {strokes.length ? `${strokes.length} mark${strokes.length === 1 ? "" : "s"}` : "Draw on the page"}</span>
          <button type="button" className="icon-btn sm" title="Undo last mark" disabled={!strokes.length} onClick={() => setStrokes((a) => a.slice(0, -1))}><Icon name="undo" size={14} /></button>
          <button type="button" className="icon-btn sm" title="Clear all marks" disabled={!strokes.length} onClick={() => setStrokes([])}><Icon name="trash" size={14} /></button>
          <span className="grow" />
          <button type="button" className="icon-btn sm" title="Stop drawing" aria-label="Stop drawing" onClick={onExit}><Icon name="x" size={14} /></button>
        </div>
        {hostChat ? (
          <div className="crow hint">{posted && posted === strokes.length ? "Added to the chat — type what to change there." : strokes.length ? "Adding to the chat…" : "Draw on the page; it is added to the chat."}</div>
        ) : (
        <div className="crow">
          <input value={text} placeholder={strokes.length ? "Describe what to change where you drew…" : "Circle or point at something, then describe the change…"} aria-label="Describe the change"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); if (e.key === "Escape") onExit(); }} />
          <button type="button" className="send" disabled={!text.trim() || !strokes.length || busy} title={sendLabel} aria-label={sendLabel} onClick={() => void send()}><Icon name="send" size={16} /></button>
        </div>
        )}
      </div>
    </>
  );
}
