import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { DiagramEditor } from "./Diagram";
import type { Env } from "./docs/env";
import type { DiagramSpec, Problem, StructNode, Structure } from "../types";

type Call = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
type Sub = "structure" | "diagrams";
const DIAGRAMS: { id: string; label: string; hint: string }[] = [
  { id: "architecture", label: "Architecture", hint: "Files and layers, and how they depend on each other" },
  { id: "workflow", label: "Workflow", hint: "Pages, links and user actions" },
  { id: "sequence", label: "Sequence", hint: "Who calls whom, in order" },
  { id: "dataflow", label: "Data flow", hint: "Where data is fetched, held and shown" },
  { id: "lifecycle", label: "Lifecycle", hint: "Mount, effects and cleanup of the components" },
];

type Props = {
  query: string;
  call: Call; project: string; filesKey: string; env: Env; onOpenFile: (path: string, line?: number) => void;
};

export function LayersPanel(p: Props) {
  const [sub, setSub] = useState<Sub>(localStorage.getItem("forge.layers.sub") === "diagrams" ? "diagrams" : "structure");
  const pick = (s: Sub) => { setSub(s); try { localStorage.setItem("forge.layers.sub", s); } catch { /* ignore */ } };
  return (
    <div className="layers-panel">
      <div className="subtabs" role="tablist">
        {([["structure", "Structure", "tree"], ["diagrams", "Diagrams", "diagram"]] as const).map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={sub === id} className={sub === id ? "on" : ""} onClick={() => pick(id)}><Icon name={icon} size={14} /> {label}</button>
        ))}
      </div>
      <div className="sub-body">
        {sub === "structure" ? <StructureView call={p.call} filesKey={p.filesKey} project={p.project} query={p.query} onOpenFile={p.onOpenFile} /> : null}
        {sub === "diagrams" ? <DiagramsView call={p.call} filesKey={p.filesKey} project={p.project} env={p.env} /> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------- structure */
const ROLE_COLOR: Record<string, string> = { page: "#2563eb", component: "#8b5cf6", hook: "#06b6d4", lib: "#10b981", api: "#f59e0b", style: "#ec4899", config: "#77776f", asset: "#84cc16", test: "#ef4444", entry: "#0ea5e9", data: "#14b8a6", type: "#6366f1" };

function matches(n: StructNode, q: string): boolean {
  if (n.path.toLowerCase().includes(q) || n.components?.some((c) => c.toLowerCase().includes(q))) return true;
  return Boolean(n.children?.some((c) => matches(c, q)));
}

function Row({ n, depth, q, open, toggle, onOpenFile }: { n: StructNode; depth: number; q: string; open: Record<string, boolean>; toggle: (p: string) => void; onOpenFile: (p: string) => void }) {
  if (q && !matches(n, q)) return null;
  const isDir = n.type === "dir";
  const isOpen = q ? true : open[n.path] ?? depth < 2;
  return (
    <>
      <button className={`srow${n.unused ? " unused" : ""}`} style={{ paddingLeft: 10 + depth * 16 }} title={n.path || "/"}
        onClick={() => (isDir ? toggle(n.path) : onOpenFile(n.path))}>
        <span className="chev">{isDir ? <Icon name="chevron" size={12} /> : null}</span>
        <Icon name={isDir ? "folder" : "file"} size={14} />
        <span className="nm">{n.name || "project"}</span>
        {n.role ? <span className="role" style={{ background: (ROLE_COLOR[n.role] ?? "#77776f") + "22", color: ROLE_COLOR[n.role] ?? "#77776f" }}>{n.roleLabel ?? n.role}</span> : null}
        {n.components?.length ? <span className="muted small">{n.components.join(", ")}</span> : null}
        <span className="grow" />
        {n.unused ? <span className="role warn">unused</span> : null}
        <span className="muted small">{isDir ? `${n.files ?? 0} files` : `${n.lines} lines`}</span>
      </button>
      {isDir && isOpen ? n.children?.map((c) => <Row key={c.path} n={c} depth={depth + 1} q={q} open={open} toggle={toggle} onOpenFile={onOpenFile} />) : null}
    </>
  );
}

export function StructureView({ call, filesKey, project, query, onOpenFile }: { call: Call; filesKey: string; project: string; query: string; onOpenFile: (p: string, l?: number) => void }) {
  const [data, setData] = useState<Structure | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    setErr(null);
    call<Structure>("forge_ui_structure").then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [call, filesKey, project]);
  const q = query.trim().toLowerCase();
  const toggle = useCallback((p: string) => setOpen((o) => ({ ...o, [p]: !(o[p] ?? true) })), []);
  if (err) return <div className="empty big">Could not read the project: {err}</div>;
  if (!data) return <div className="empty big">Reading the project…</div>;
  const s = data.summary;
  const roles = Object.entries(s.roles).sort((a, b) => b[1] - a[1]);
  return (
    <div className="structure">
      <div className="stats">
        {[["Files", s.files], ["Lines", s.lines], ["Components", s.components], ["State", s.stateVars], ["Handlers", s.handlers], ["Effects", s.effects], ["Routes", s.routes.length]].map(([k, v]) => (
          <div key={String(k)} className="stat"><b>{Number(v).toLocaleString()}</b><span>{k}</span></div>
        ))}
      </div>
      <div className="rolebar">{roles.map(([r, c]) => <span key={r} className="role" style={{ background: (ROLE_COLOR[r] ?? "#77776f") + "22", color: ROLE_COLOR[r] ?? "#77776f" }}>{r} · {c}</span>)}</div>
      {data.problems.length ? <Problems list={data.problems} onOpenFile={onOpenFile} /> : <div className="okline"><Icon name="check" size={14} /> No structural problems found.</div>}
      <div className="tree">
        {(data.tree.children ?? []).map((c) => <Row key={c.path} n={c} depth={0} q={q} open={open} toggle={toggle} onOpenFile={(p) => onOpenFile(p)} />)}
      </div>
      {Object.keys(s.dependencies).length ? (
        <details className="deps"><summary>{Object.keys(s.dependencies).length} dependencies · {Object.keys(s.devDependencies).length} dev</summary>
          <div>{Object.entries(s.dependencies).map(([k, v]) => <span key={k} className="chip">{k} <i>{v}</i></span>)}</div></details>
      ) : null}
    </div>
  );
}

function Problems({ list, onOpenFile }: { list: Problem[]; onOpenFile: (p: string, l?: number) => void }) {
  return (
    <div className="problems">
      <div className="ptitle"><Icon name="warn" size={14} /> {list.length} problem{list.length === 1 ? "" : "s"}</div>
      {list.slice(0, 40).map((x, i) => (
        <button key={i} className={`prob ${x.severity}`} onClick={() => onOpenFile(x.path, x.line || undefined)}>
          <span className="kind">{x.kind}</span><span>{x.message}</span><span className="muted small">{x.path}{x.line ? `:${x.line}` : ""}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------- diagrams */
type DiagramResp = { spec: DiagramSpec; edited: boolean; stale: boolean; docId?: string };

function DiagramsView({ call, filesKey, project, env }: { call: Call; filesKey: string; project: string; env: Env }) {
  const [type, setType] = useState(localStorage.getItem("forge.diagram.type") || "architecture");
  const [r, setR] = useState<DiagramResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spec, setSpec] = useState<DiagramSpec | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => {
    setErr(null);
    return call<DiagramResp>("forge_ui_diagram", { type }).then((d) => { setR(d); setSpec(d.spec); setDirty(false); }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [call, type]);
  useEffect(() => { void load(); }, [load, project, nonce]);
  // the project changed while the diagram was untouched: pick up the new one
  useEffect(() => { if (!dirty) setNonce((n) => n + 1); }, [filesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (t: string) => { setType(t); try { localStorage.setItem("forge.diagram.type", t); } catch { /* ignore */ } };
  const keep = async () => {
    if (!spec) return;
    setBusy(true);
    try { await call("forge_ui_diagram_save", { type, spec }); env.say("Your version is kept and listed in Docs"); await load(); } catch (e) { env.say(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true);
    try { await call("forge_ui_diagram_reset", { type }); await load(); } catch (e) { env.say(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const hint = useMemo(() => DIAGRAMS.find((d) => d.id === type)?.hint ?? "", [type]);
  const banner = r?.stale ? (
    <div className="banner warn"><Icon name="warn" size={14} /> The app changed since you edited this diagram.
      <button onClick={() => void reset()}>Regenerate</button><button onClick={() => void keep()}>Keep mine</button></div>
  ) : null;
  return (
    <div className="diagrams">
      <div className="dtypes" role="tablist">
        {DIAGRAMS.map((d) => <button key={d.id} role="tab" aria-selected={type === d.id} className={type === d.id ? "on" : ""} onClick={() => choose(d.id)}>{d.label}</button>)}
        <span className="muted small hint">{hint}</span>
      </div>
      {err ? <div className="empty big">{err}</div> : !spec ? <div className="empty big">Drawing…</div> : (
        <DiagramEditor key={`${type}:${r?.docId ?? "gen"}`} spec={spec} docId={r?.docId ?? `layers-${type}`} docName={`${type}.diagram.json`} env={env}
          onChange={(s) => { setSpec(s); setDirty(true); }} banner={banner} context="layers"
          extra={(
            <>
              {dirty ? <button className="primary" disabled={busy} onClick={() => void keep()}><Icon name="save" size={14} /> Keep my edits</button> : null}
              {r?.edited || dirty ? <button disabled={busy} onClick={() => void reset()} title="Discard hand edits and draw it from the code again"><Icon name="refresh" size={14} /> Regenerate</button> : null}
              {r?.edited && !dirty ? <span className="chip">edited</span> : null}
            </>
          )} />
      )}
    </div>
  );
}
