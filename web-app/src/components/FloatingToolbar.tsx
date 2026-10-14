import { useState } from "react";
import { Icon } from "./Icon";
import { APP_VERSION } from "../version";
import type { Dock, ThemePref, Tool, ToolPos } from "../types";

type Props = {
  tool: Tool; setTool: (t: Tool) => void;
  dock: Dock; setDock: (d: Dock) => void;
  theme: ThemePref; setTheme: (t: ThemePref) => void;
  shortcuts: boolean; setShortcuts: (b: boolean) => void;
  /** Inside an AI app: post the selected element into the host's chat (undefined = standalone, no switch). */
  postSel?: boolean; setPostSel: (b: boolean) => void;
  /** Where the toolbar sits: "auto" picks the best edge, or the user chose one (menu or drag). */
  pos: ToolPos; setPos: (p: ToolPos) => void;
};

/**
 * The floating pill from the Lovable screenshot.
 *  - Always visible: Select, Text, Draw, Comment.
 *  - Only while the cursor is on the toolbar: "More" (...) and the minimize arrow (>).
 *  - Minimize slides it to the side edge, where a "Dock" button brings it back.
 */
export function FloatingToolbar({ tool, setTool, dock, setDock, theme, setTheme, shortcuts, setShortcuts, postSel, setPostSel, pos, setPos }: Props) {
  const [open, setOpen] = useState(false);

  if (dock === "hidden") {
    return <button className="restore-handle" title="Show toolbar" onClick={() => setDock("dock")} aria-label="Show toolbar" />;
  }
  if (dock === "minimized") {
    return (
      <button className="side-dock" title="Dock the toolbar" onClick={() => setDock("dock")}>
        <Icon name="chevronl" size={15} /> Dock
      </button>
    );
  }

  // Drag the pill by its background and drop it near an edge: it snaps to top / bottom / left / right.
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, .menu")) return;
    const area = (e.currentTarget.closest(".tools-dock") as HTMLElement | null)?.parentElement?.getBoundingClientRect(); if (!area) return;
    const mv = (ev: PointerEvent) => { void ev; };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      const x = (ev.clientX - area.left) / area.width, y = (ev.clientY - area.top) / area.height;
      const d = { top: y, bottom: 1 - y, left: x * (area.width / area.height), right: (1 - x) * (area.width / area.height) };
      const best = (Object.keys(d) as ("top" | "bottom" | "left" | "right")[]).sort((a, b) => d[a] - d[b])[0];
      setPos(best);
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };
  const toggle = (t: Tool) => setTool(tool === t ? "browse" : t);
  const Item = ({ icon, label, active, onClick }: { icon?: string; label: string; active: boolean; onClick: () => void }) => (
    <button className={`menu-item${active ? " on" : ""}`} onClick={onClick}>
      {icon ? <Icon name={icon} size={16} /> : null} {label}
      {active ? <span className="tick"><Icon name="check" size={14} /></span> : null}
    </button>
  );

  return (
    <div className={`floating${open ? " menu-open" : ""}`} onMouseLeave={() => setOpen(false)}>
      {open ? (
        <div className="menu" role="menu">
          <Item icon="dock" label="Dock" active onClick={() => setOpen(false)} />
          <Item icon="minimize" label="Minimize" active={false} onClick={() => { setOpen(false); setDock("minimized"); }} />
          <Item icon="eyeoff" label="Hide" active={false} onClick={() => { setOpen(false); setDock("hidden"); }} />
          <div className="menu-title">POSITION</div>
          <div className="pos-row" role="group" aria-label="Toolbar position">
            {(["auto", "top", "bottom", "left", "right"] as ToolPos[]).map((p) => (
              <button key={p} className={`pos-btn${pos === p ? " on" : ""}`} title={p === "auto" ? "Choose the best place automatically" : `Put the toolbar at the ${p}`} onClick={() => setPos(p)}>{p[0].toUpperCase() + p.slice(1)}</button>
            ))}
          </div>
          <div className="menu-hint">Or drag the toolbar to any edge.</div>
          <div className="menu-title">THEME</div>
          <Item icon="contrast" label="Auto" active={theme === "auto"} onClick={() => setTheme("auto")} />
          <Item icon="sun" label="Light" active={theme === "light"} onClick={() => setTheme("light")} />
          <Item icon="moon" label="Dark" active={theme === "dark"} onClick={() => setTheme("dark")} />
          <div className="menu-sep" />
          <label className="menu-item switch">
            <span>Keyboard shortcuts</span>
            <input type="checkbox" checked={shortcuts} onChange={(e) => setShortcuts(e.target.checked)} />
            <i />
          </label>
          {postSel !== undefined ? (
            <label className="menu-item switch">
              <span>Post selection to chat</span>
              <input type="checkbox" checked={postSel} onChange={(e) => setPostSel(e.target.checked)} />
              <i />
            </label>
          ) : null}
          <div className="menu-version">Forge v{APP_VERSION}</div>
        </div>
      ) : null}
      <div className="toolbar" onPointerDown={drag} title="Drag to move">
        <button className={`tool${tool === "select" ? " active" : ""}`} title="Select an element (V)" onClick={() => toggle("select")}><Icon name="cursor" /></button>
        <button className={`tool${tool === "text" ? " active" : ""}`} title="Edit text (T)" onClick={() => toggle("text")}><Icon name="type" /></button>
        <button className={`tool${tool === "draw" ? " active" : ""}`} title="Draw annotation (D)" onClick={() => toggle("draw")}><Icon name="pencil" /></button>
        <button className={`tool${tool === "comment" ? " active" : ""}`} title="Comment on an element (C)" onClick={() => toggle("comment")}><Icon name="message" /></button>
        <div className="extras">
          <button className={`tool${open ? " active" : ""}`} title="More" onClick={() => setOpen(!open)}><Icon name="dots" /></button>
          <button className="tool" title="Minimize toolbar" onClick={() => { setOpen(false); setDock("minimized"); }}><Icon name="chevron" /></button>
        </div>
      </div>
    </div>
  );
}
