import { useState } from "react";
import { Icon } from "./Icon";
import { useAnchored } from "../anchor";
import type { Changes, Described, Rect, Sel } from "../types";

function hex(value: string): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

type Props = {
  sel: Sel; rect: Rect | undefined; bounds: { w: number; h: number };
  described: Described | null;
  onLive: (c: Changes) => void; onEditText: () => void;
  onOpenCode: () => void; onClose: () => void; onEscape: () => void;
};

/**
 * The edit bar that sits ON the selected element (like Lovable's): colors, size, bold, padding, edit text, ask the AI.
 * Every change is applied live: the element updates instantly and is written to the source a moment later.
 */
export function ElementBar({ sel, rect, bounds, described, onLive, onEditText, onOpenCode, onClose, onEscape }: Props) {
  const { ref, style, placement } = useAnchored(rect, bounds);
  const s = sel.styles;
  const [textColor, setTextColor] = useState(hex(s.color) ?? "#000000");
  const [bgColor, setBgColor] = useState(hex(s.backgroundColor) ?? "#ffffff");
  const [fontSize, setFontSize] = useState(Math.round(parseFloat(s.fontSize) || 16));
  const [padding, setPadding] = useState(Math.round(parseFloat(s.padding) || 0));
  const [bold, setBold] = useState(Number(s.fontWeight) >= 600);
  const dynamic = Boolean(described?.dynamicClassName);
  const canText = Boolean(described?.ok && described.text !== null && described.text !== undefined);

  const setSize = (v: number) => { const n = Math.max(4, Math.min(200, Math.round(v))); setFontSize(n); onLive({ fontSize: n }); };
  const setPad = (v: number) => { const n = Math.max(0, Math.min(400, Math.round(v))); setPadding(n); onLive({ padding: n }); };

  return (
    <div ref={ref} style={style} className={`ebar ${placement}`} role="toolbar" aria-label={`Edit <${sel.tag}>`}
      onKeyDown={(e) => { if (e.key === "Escape") { (e.target as HTMLElement).blur(); onEscape(); } }}>
      <div className="ebar-row">
        <button className="chip" title={`Open ${sel.path}:${sel.line} in the code editor`} onClick={onOpenCode}>&lt;{sel.tag}&gt;</button>
        {dynamic ? <span className="ebar-note">className is dynamic here. Ask Claude below, or use the code editor.</span> : (
          <>
            <label className="sw" title="Text color">
              <Icon name="textcolor" size={15} /><span className="swbar" style={{ background: textColor }} />
              <input type="color" aria-label="Text color" value={textColor} onChange={(e) => { setTextColor(e.target.value); onLive({ textColor: e.target.value }); }} />
            </label>
            <label className="sw" title="Background color">
              <Icon name="fill" size={15} /><span className="swbar" style={{ background: bgColor }} />
              <input type="color" aria-label="Background color" value={bgColor} onChange={(e) => { setBgColor(e.target.value); onLive({ bgColor: e.target.value }); }} />
            </label>
            <span className="vsep" />
            <div className="stepper" title="Font size (px)">
              <button aria-label="Smaller text" onClick={() => setSize(fontSize - 2)}><Icon name="minus" size={13} /></button>
              <input aria-label="Font size" type="number" value={fontSize} onChange={(e) => setSize(Number(e.target.value))} />
              <button aria-label="Larger text" onClick={() => setSize(fontSize + 2)}><Icon name="plus" size={13} /></button>
            </div>
            <button className={`tb${bold ? " on" : ""}`} title="Bold" aria-pressed={bold}
              onClick={() => { setBold(!bold); onLive({ fontWeight: bold ? "normal" : "bold" }); }}><Icon name="bold" size={15} /></button>
            <div className="stepper" title="Padding (px)">
              <Icon name="pad" size={14} />
              <button aria-label="Less padding" onClick={() => setPad(padding - 4)}><Icon name="minus" size={13} /></button>
              <input aria-label="Padding" type="number" value={padding} onChange={(e) => setPad(Number(e.target.value))} />
              <button aria-label="More padding" onClick={() => setPad(padding + 4)}><Icon name="plus" size={13} /></button>
            </div>
          </>
        )}
        {canText ? <button className="tb" title="Edit text on the page" aria-label="Edit text" onClick={onEditText}><Icon name="pencil" size={15} /></button> : null}
        <span className="vsep" />
        <button className="tb" title="Deselect" aria-label="Deselect" onClick={onClose}><Icon name="x" size={15} /></button>
      </div>
    </div>
  );
}

/** Small hint shown on the element while its text is being edited in place. */
export function TextHint({ rect, bounds }: { rect: Rect | undefined; bounds: { w: number; h: number } }) {
  const { ref, style, placement } = useAnchored(rect, bounds);
  return (
    <div ref={ref} style={style} className={`ebar hint ${placement}`}>
      <Icon name="pencil" size={14} /> Editing text <span className="muted">· Enter to save · Esc to cancel</span>
    </div>
  );
}
