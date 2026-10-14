import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { formatSize } from "../util";

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[] };

function build(paths: string[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const path of paths) {
    let node = root;
    const parts = path.split("/");
    parts.slice(0, -1).forEach((part, i) => {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    });
    node.files.push(path);
  }
  return root;
}

export type TreeProps = {
  files: string[];
  active?: string | null;
  touched?: Record<string, number>;
  writing?: Set<string>;
  sizes?: Record<string, number>;
  onOpen: (path: string) => void;
  /** extra buttons shown at the end of a row (file or folder) */
  actions?: (path: string, isDir: boolean) => ReactNode;
};

/** Folder structure of the project. Used by the Code tab (open a file) and the Files tab (download). */
export function FileTree(p: TreeProps) {
  const tree = useMemo(() => build(p.files), [p.files]);
  return <Level dir={tree} depth={0} {...p} />;
}

function Level({ dir, depth, ...p }: TreeProps & { dir: Dir; depth: number }) {
  return (
    <>
      {[...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
        <Branch key={child.path} dir={child} depth={depth} {...p} />
      ))}
      {[...dir.files].sort().map((path) => (
        <div key={path} className={`row file${path === p.active ? " active" : ""}${p.touched?.[path] ? " touched" : ""}`}>
          <button className="row-main" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => p.onOpen(path)} title={path}>
            <Icon name="file" size={14} />
            <span className="name">{path.split("/").pop()}</span>
            {p.writing?.has(path) ? <span className="spinner xs" title="The AI is writing this file" /> : null}
            {p.touched?.[path] && !p.writing?.has(path) ? <span className="dot" title="Changed by the AI or outside the editor" /> : null}
            {p.sizes?.[path] !== undefined ? <span className="size">{formatSize(p.sizes[path])}</span> : null}
          </button>
          {p.actions ? <span className="row-actions">{p.actions(path, false)}</span> : null}
        </div>
      ))}
    </>
  );
}

function Branch({ dir, depth, ...p }: TreeProps & { dir: Dir; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  return (
    <>
      <div className="row dir">
        <button className="row-main" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => setOpen(!open)}>
          <span className="chev">{open ? "▾" : "▸"}</span><Icon name="folder" size={14} /><span className="name">{dir.name}</span>
        </button>
        {p.actions ? <span className="row-actions">{p.actions(dir.path, true)}</span> : null}
      </div>
      {open ? <Level dir={dir} depth={depth + 1} {...p} /> : null}
    </>
  );
}
