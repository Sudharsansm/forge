import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import { AskInline } from "../Diagram";
import { useHistory } from "../../lib/useHistory";
import type { Cell, DocSelection, Sheet } from "../../types";
import type { EditorProps } from "./shared";

const RH = 28, CW = 120, HW = 46, OVER = 6;
const colName = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const typed = (v: string): Cell => {
  const s = v.trim();
  if (s === "") return null;
  if (s.startsWith("=")) return s;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return v;
};
const show = (v: Cell | undefined) => (v === null || v === undefined ? "" : String(v));

/** csv and xlsx: a windowed grid (thousands of rows stay fast), formula bar, sheet tabs, undo/redo, add/delete rows and columns. */
export function SheetGrid({ item, payload, onChange, env, readOnly }: EditorProps) {
  const isCsv = item.kind === "csv";
  const sheets: Sheet[] = isCsv ? [{ name: item.name, rows: payload.rows }] : payload.sheets;
  const [si, setSi] = useState(0);
  const [cur, setCur] = useState({ r: 0, c: 0 });
  const [range, setRange] = useState<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0, h: 480, w: 800 });
  const box = useRef<HTMLDivElement>(null);
  const sheet = sheets[Math.min(si, sheets.length - 1)];
  const rows = sheet.rows;
  const cols = Math.max(8, ...rows.map((r) => r.length)) + 1;
  const nRows = rows.length + 20;
  const set = (next: Sheet[]) => onChange(isCsv ? { ...payload, rows: next[0].rows } : { ...payload, sheets: next });
  const hist = useHistory<Sheet[]>(sheets, set);
  useEffect(() => { setCur({ r: 0, c: 0 }); setRange(null); setEditing(null); hist.reset(); }, [item.id, si]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight, w: el.clientWidth })));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const edit = (fn: (s: Sheet) => void, key?: string) => { const c = structuredClone(sheets); fn(c[Math.min(si, c.length - 1)]); hist.commit(c, key); };
  const setCell = (r: number, c: number, v: Cell) => edit((s) => { while (s.rows.length <= r) s.rows.push([]); const row = s.rows[r]; while (row.length <= c) row.push(null); row[c] = v; if (s.calc) s.calc = null; });
  const commit = (v: string) => { setCell(cur.r, cur.c, typed(v)); setEditing(null); };

  const selection = useMemo<DocSelection | null>(() => {
    const a = range ?? { r1: cur.r, c1: cur.c, r2: cur.r, c2: cur.c };
    const r1 = Math.min(a.r1, a.r2), r2 = Math.max(a.r1, a.r2), c1 = Math.min(a.c1, a.c2), c2 = Math.max(a.c1, a.c2);
    const ref = `${colName(c1)}${r1 + 1}${r1 === r2 && c1 === c2 ? "" : `:${colName(c2)}${r2 + 1}`}`;
    const vals = rows.slice(r1, Math.min(r2 + 1, r1 + 40)).map((r) => r.slice(c1, c2 + 1).map(show).join("\t")).join("\n");
    return { docId: item.id, docName: item.name, kind: item.kind, label: `${isCsv ? "" : `${sheet.name}!`}${ref}`, text: vals, detail: JSON.stringify({ sheet: sheet.name, range: ref }) };
  }, [range, cur, rows, item, isCsv, sheet.name]);
  useEffect(() => { env.onSelection(selection); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (dr: number, dc: number) => setCur((p) => ({ r: Math.max(0, Math.min(nRows - 1, p.r + dr)), c: Math.max(0, Math.min(cols - 1, p.c + dc)) }));
  const onKey = (e: React.KeyboardEvent) => {
    if (editing !== null) {
      if (e.key === "Enter") { e.preventDefault(); commit(editing); move(1, 0); }
      else if (e.key === "Tab") { e.preventDefault(); commit(editing); move(0, e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") setEditing(null);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) hist.redo(); else hist.undo(); return; }
    if (mod && e.key.toLowerCase() === "c") { void navigator.clipboard?.writeText(selection?.text ?? "").catch(() => undefined); return; }
    if (readOnly) return;
    if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      navigator.clipboard?.readText().then((t) => {
        const grid = t.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
        edit((s) => { grid.forEach((gr, i) => gr.forEach((v, j) => { const r = cur.r + i, c = cur.c + j; while (s.rows.length <= r) s.rows.push([]); while (s.rows[r].length <= c) s.rows[r].push(null); s.rows[r][c] = typed(v); })); if (s.calc) s.calc = null; });
      }).catch(() => env.say("Your browser blocked pasting. Use Ctrl+V after clicking a cell, or type the values."));
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); move(1, 0); } else if (e.key === "ArrowUp") { e.preventDefault(); move(-1, 0); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(0, -1); } else if (e.key === "ArrowRight") { e.preventDefault(); move(0, 1); }
    else if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); setEditing(show(rows[cur.r]?.[cur.c])); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); const a = range ?? { r1: cur.r, c1: cur.c, r2: cur.r, c2: cur.c }; edit((s) => { for (let r = Math.min(a.r1, a.r2); r <= Math.max(a.r1, a.r2); r++) for (let c = Math.min(a.c1, a.c2); c <= Math.max(a.c1, a.c2); c++) if (s.rows[r]) s.rows[r][c] = null; if (s.calc) s.calc = null; }); }
    else if (!mod && e.key.length === 1) setEditing(e.key);
  };

  const r0 = Math.max(0, Math.floor(scroll.top / RH) - OVER), r1 = Math.min(nRows, Math.ceil((scroll.top + scroll.h) / RH) + OVER);
  const c0 = Math.max(0, Math.floor(scroll.left / CW) - 2), c1 = Math.min(cols, Math.ceil((scroll.left + scroll.w) / CW) + 2);
  const inRange = (r: number, c: number) => range && r >= Math.min(range.r1, range.r2) && r <= Math.max(range.r1, range.r2) && c >= Math.min(range.c1, range.c2) && c <= Math.max(range.c1, range.c2);
  const formula = typeof rows[cur.r]?.[cur.c] === "string" && String(rows[cur.r][cur.c]).startsWith("=");
  const shown = (r: number, c: number) => { const v = rows[r]?.[c]; return typeof v === "string" && v.startsWith("=") && sheet.calc ? show(sheet.calc[r]?.[c]) || v : show(v); };

  useEffect(() => { // keep the current cell visible
    const el = box.current; if (!el) return;
    const y = cur.r * RH, x = cur.c * CW;
    if (y < el.scrollTop) el.scrollTop = y; else if (y + RH > el.scrollTop + el.clientHeight - RH) el.scrollTop = y + RH - el.clientHeight + RH;
    if (x < el.scrollLeft) el.scrollLeft = x; else if (x + CW > el.scrollLeft + el.clientWidth - HW) el.scrollLeft = x + CW - el.clientWidth + HW;
  }, [cur]);

  return (
    <div className="sheet">
      <div className="dg-bar">
        <button className="icon-btn" title="Undo" disabled={!hist.canUndo} onClick={hist.undo}><Icon name="undo" size={16} /></button>
        <button className="icon-btn" title="Redo" disabled={!hist.canRedo} onClick={hist.redo}><Icon name="redo" size={16} /></button>
        {!readOnly ? <>
          <button onClick={() => edit((s) => { s.rows.splice(cur.r + 1, 0, []); })}><Icon name="plus" size={13} /> Row</button>
          <button onClick={() => edit((s) => { s.rows.forEach((r) => r.splice(cur.c + 1, 0, null)); })}><Icon name="plus" size={13} /> Column</button>
          <button onClick={() => edit((s) => { if (s.rows.length > 1) s.rows.splice(cur.r, 1); })}><Icon name="trash" size={13} /> Row</button>
          <button onClick={() => edit((s) => { s.rows.forEach((r) => r.splice(cur.c, 1)); })}><Icon name="trash" size={13} /> Column</button></> : null}
        <span className="grow" />
        {sheet.truncated || payload.truncated ? <span className="chip warn">Only the first {nRows - 20} rows are shown</span> : null}
        <span className="muted small">{rows.length} rows</span>
      </div>
      <div className="formula"><span className="cellref">{colName(cur.c)}{cur.r + 1}</span>
        <input value={editing ?? show(rows[cur.r]?.[cur.c])} readOnly={readOnly} placeholder={readOnly ? "" : "Type a value, or =formula"}
          onFocus={() => { if (!readOnly && editing === null) setEditing(show(rows[cur.r]?.[cur.c])); }}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { commit(editing ?? ""); box.current?.focus(); } if (e.key === "Escape") { setEditing(null); box.current?.focus(); } }}
          onBlur={() => { if (editing !== null) commit(editing); }} aria-label="Cell content" />
        {formula && sheet.calc ? <span className="muted small">= {show(sheet.calc[cur.r]?.[cur.c])}</span> : null}
      </div>
      <div className="grid-scroll" ref={box} tabIndex={0} onKeyDown={onKey} onScroll={(e) => { const t = e.currentTarget; setScroll({ top: t.scrollTop, left: t.scrollLeft, h: t.clientHeight, w: t.clientWidth }); }}>
        <div style={{ width: HW + cols * CW, height: RH + nRows * RH, position: "relative" }}>
          <div className="gh corner" style={{ left: 0, top: 0, width: HW, height: RH, position: "sticky", zIndex: 5, marginBottom: -RH }} />
          <div className="gh-row" style={{ position: "sticky", top: 0, zIndex: 3, height: RH, marginLeft: HW, width: cols * CW }}>
            {Array.from({ length: c1 - c0 }, (_, k) => c0 + k).map((c) => <div key={c} className={`gh${cur.c === c ? " on" : ""}`} style={{ position: "absolute", top: 0, left: c * CW, width: CW, height: RH }}>{colName(c)}</div>)}
          </div>
          {Array.from({ length: r1 - r0 }, (_, k) => r0 + k).map((r) => (
            <div key={r} className="grow-r" style={{ position: "absolute", top: RH + r * RH, left: 0, height: RH, width: HW + cols * CW }}>
              <div className={`gh rh${cur.r === r ? " on" : ""}`} style={{ position: "sticky", left: 0, width: HW, height: RH, zIndex: 2 }}>{r + 1}</div>
              {Array.from({ length: c1 - c0 }, (_, k) => c0 + k).map((c) => {
                const active = cur.r === r && cur.c === c;
                return (
                  <div key={c} className={`gc${active ? " active" : ""}${inRange(r, c) ? " inrange" : ""}${typeof rows[r]?.[c] === "number" ? " num" : ""}`}
                    style={{ position: "absolute", top: 0, left: HW + c * CW, width: CW, height: RH }}
                    onMouseDown={(e) => { if (editing !== null) commit(editing); if (e.shiftKey) setRange({ r1: cur.r, c1: cur.c, r2: r, c2: c }); else { setCur({ r, c }); setRange(null); } box.current?.focus(); }}
                    onMouseEnter={(e) => { if (e.buttons === 1) setRange({ r1: cur.r, c1: cur.c, r2: r, c2: c }); }}
                    onDoubleClick={() => { if (!readOnly) setEditing(show(rows[r]?.[c])); }}>
                    {active && editing !== null ? <input autoFocus className="cell-input" value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={() => { if (editing !== null) commit(editing); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); commit(editing); move(1, 0); box.current?.focus(); } else if (e.key === "Tab") { e.preventDefault(); commit(editing); move(0, 1); box.current?.focus(); } else if (e.key === "Escape") { setEditing(null); box.current?.focus(); } }} /> : shown(r, c)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {!isCsv && sheets.length > 0 ? (
        <div className="sheet-tabs">
          {sheets.map((s, i) => <button key={i} className={i === si ? "on" : ""} onClick={() => setSi(i)}>{s.name}</button>)}
          {!readOnly ? <button title="Add sheet" onClick={() => { const c = structuredClone(sheets); c.push({ name: `Sheet${c.length + 1}`, rows: [[null]] }); hist.commit(c); setSi(c.length - 1); }}><Icon name="plus" size={13} /></button> : null}
        </div>
      ) : null}
      <AskInline env={env} sel={selection} placeholder="Ask the AI to change the selected cells, add a column, fix formulas…" />
    </div>
  );
}
