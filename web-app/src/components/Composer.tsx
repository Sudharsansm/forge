import { useState } from "react";
import { Icon } from "./Icon";
import type { Sel } from "../types";

type Props = { hostChat?: boolean; sel: Sel; sendLabel: string; busy: boolean; onSend: (instruction: string) => void; onClear: () => void; onEscape: () => void };

/**
 * Lovable-style "chat" for the selected component: the element shows up as a chip, you describe the change, and it goes to Claude
 * (into the host's chat in an MCP host). The selection is also shared with Claude as context, so typing in Claude's own chat works too.
 */
export function Composer({ hostChat, sel, sendLabel, busy, onSend, onClear, onEscape }: Props) {
  const [text, setText] = useState("");
  const file = sel.path.split("/").pop() ?? sel.path;
  const send = () => { if (text.trim() && !busy) { onSend(text.trim()); setText(""); } };
  return (
    <div className="composer" role="group" aria-label="Ask Claude about the selected element">
      <div className="cchips">
        <span className="cchip" title={sel.line ? `${sel.path}:${sel.line}:${sel.col}` : sel.path}>
          <Icon name="cursor" size={13} /> &lt;{sel.tag}&gt; <span className="muted">{file}{sel.line ? `:${sel.line}` : ""}</span>
          <button type="button" aria-label="Remove the selected element" title="Remove" onClick={onClear}><Icon name="x" size={12} /></button>
        </span>
        {sel.text ? <span className="ctext" title={sel.text}>“{sel.text.length > 48 ? sel.text.slice(0, 47) + "…" : sel.text}”</span> : null}
      </div>
      {hostChat ? <div className="chint">Shared with Claude. Type your change in Claude's chat, for example “make this bigger”.</div> : <div className="crow">
        <input value={text} placeholder="Ask Claude to change this element…" aria-label="Describe the change"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); if (e.key === "Escape") { (e.target as HTMLElement).blur(); onEscape(); } }} />
        <button type="button" className="send" disabled={!text.trim() || busy} title={sendLabel} aria-label={sendLabel} onClick={send}><Icon name="send" size={16} /></button>
      </div>}
    </div>
  );
}
