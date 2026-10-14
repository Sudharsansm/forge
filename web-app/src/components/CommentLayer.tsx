import { useState } from "react";
import { Icon } from "./Icon";
import { useAnchored } from "../anchor";
import type { Comment, Rect, Sel } from "../types";

type Props = {
  comments: Comment[]; rects: Record<string, Rect>; bounds: { w: number; h: number };
  draft: Sel | null; sendLabel: string;
  onAdd: (text: string) => void; onCancel: () => void; onDelete: (id: number) => void; onSend: () => void; onClear: () => void;
};

/** Comment tool: a pin on each commented element, a small popover on the element being commented, and a "send" tray. */
export function CommentLayer({ comments, rects, bounds, draft, sendLabel, onAdd, onCancel, onDelete, onSend, onClear }: Props) {
  const [active, setActive] = useState<number | null>(null);
  const open = comments.find((c) => c.id === active);
  return (
    <>
      {comments.map((c, i) => {
        const r = rects[c.sel.src];
        if (!r) return null;
        return (
          <button key={c.id} className={`pin${active === c.id ? " on" : ""}`} title={c.text} aria-label={`Comment ${i + 1}: ${c.text}`}
            style={{ left: Math.min(Math.max(r.x + (c.sel.click?.fx ?? 1) * r.w - 11, 4), bounds.w - 26),
                     top: Math.min(Math.max(r.y + (c.sel.click?.fy ?? 0) * r.h - 11, 4), bounds.h - 26) }}
            onClick={() => setActive(active === c.id ? null : c.id)}>{i + 1}</button>
        );
      })}
      {open && rects[open.sel.src] ? <PinCard comment={open} rect={rects[open.sel.src]} bounds={bounds} onDelete={() => { onDelete(open.id); setActive(null); }} /> : null}
      {draft ? <Draft sel={draft} rect={rects[draft.src]} bounds={bounds} onAdd={onAdd} onCancel={onCancel} /> : null}
      {comments.length > 0 ? (
        <div className="tray">
          <span className="tray-count">{comments.length}</span> comment{comments.length === 1 ? "" : "s"}
          <button className="primary" onClick={onSend}>{sendLabel}</button>
          <button className="icon-btn sm" title="Discard all comments" aria-label="Discard all comments" onClick={onClear}><Icon name="trash" size={14} /></button>
        </div>
      ) : null}
    </>
  );
}

function Draft({ sel, rect, bounds, onAdd, onCancel }: { sel: Sel; rect: Rect | undefined; bounds: { w: number; h: number }; onAdd: (t: string) => void; onCancel: () => void }) {
  const { ref, style, placement } = useAnchored(rect, bounds);
  const [text, setText] = useState("");
  const add = () => { if (text.trim()) onAdd(text.trim()); };
  return (
    <div ref={ref} style={style} className={`ebar comment ${placement}`} role="dialog" aria-label="Add a comment"
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <div className="ebar-row"><span className="chip static">&lt;{sel.tag}&gt;</span><span className="muted">Comment for the AI</span></div>
      <textarea autoFocus rows={2} placeholder="What should change here?" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(); }} />
      <div className="row">
        <button className="primary" disabled={!text.trim()} onClick={add}>Add comment</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function PinCard({ comment, rect, bounds, onDelete }: { comment: Comment; rect: Rect; bounds: { w: number; h: number }; onDelete: () => void }) {
  const { ref, style, placement } = useAnchored(rect, bounds);
  return (
    <div ref={ref} style={style} className={`ebar pincard ${placement}`}>
      <div className="ebar-row"><span className="chip static">&lt;{comment.sel.tag}&gt;</span>
        <span className="muted">{comment.sel.path}:{comment.sel.line}</span></div>
      <p>{comment.text}</p>
      <button onClick={onDelete}><Icon name="trash" size={14} /> Delete</button>
    </div>
  );
}
