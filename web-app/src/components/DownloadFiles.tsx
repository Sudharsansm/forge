import { useMemo } from "react";
import { Icon } from "./Icon";
import { Highlight } from "./Highlight";
import { dirName, extOf, fileName, formatSize, fuzzy } from "../util";

type Props = {
  project: string; title?: string; files: string[]; sizes: Record<string, number>; touched: Record<string, number>; query: string;
  onDownload: (path?: string) => void; onCopy?: (path: string) => void; onOpen: (path: string) => void;
};

/** Files tab: every file as a downloadable card (type badge, name, folder, size), like files in Claude. */
export function DownloadFiles({ project, title, files, sizes, touched, query, onDownload, onOpen }: Props) {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  const q = query.trim();
  const name = title || (project && project !== "default" ? project : "Project files");

  const results = useMemo(() => {
    if (!q) return null;
    return files.map((path) => ({ path, m: fuzzy(q, path) })).filter((r): r is { path: string; m: NonNullable<ReturnType<typeof fuzzy>> } => r.m !== null)
      .sort((a, b) => b.m.score - a.m.score || a.path.localeCompare(b.path));
  }, [files, q]);

  const flat = useMemo(() => [...files].sort((a, b) => (touched[b] ?? 0) - (touched[a] ?? 0) || a.localeCompare(b)), [files, touched]);

  /** "Code · TSX", "Document · MD", "Image · PNG": the same short label Claude shows under a file name. */
  const typeLabel = (path: string) => {
    const ext = extOf(path).toLowerCase();
    const group = ["md", "txt", "rtf", "pdf", "docx"].includes(ext) ? "Document" : ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext) ? "Image"
      : ["csv", "xlsx"].includes(ext) ? "Data" : "Code";
    return `${group} · ${(ext || "txt").toUpperCase()}`;
  };

  const card = (path: string, positions: number[] = []) => {
    const base = path.length - fileName(path).length;
    const dir = dirName(path);
    return (
      <div key={path} className={`fcard flat${touched[path] ? " touched" : ""}`}>
        <button className="fmain" onClick={() => onOpen(path)} title={`Open ${path}`}>
          <span className="ficon"><Icon name="file" size={20} /></span>
          <span className="fmeta">
            <span className="fname"><Highlight text={dir ? path : fileName(path)} positions={dir ? positions : positions.filter((i) => i >= base).map((i) => i - base)} /></span>
            <span className="fsub">{typeLabel(path)}</span>
          </span>
        </button>
        <span className="facts">
          <button className="dlbtn" title={`Download ${path}`} aria-label={`Download ${path}`} onClick={() => onDownload(path)}><Icon name="download" size={15} /> Download</button>
        </span>
      </div>
    );
  };

  return (
    <div className="dl-pane">
      <div className="dl-head">
        <div className="dl-title"><div><b className="dl-name" title={name}>{name}</b><div className="muted">{files.length} file{files.length === 1 ? "" : "s"} · {formatSize(total)}</div></div></div>
        <span className="grow" />
        <button className="dlbtn" title={`Download ${name} as a .zip`} onClick={() => onDownload()} disabled={files.length === 0}><Icon name="download" size={15} /> Download .zip</button>
      </div>
      <div className="dl-scroll">
        {files.length === 0 ? <div className="empty big">No files yet. Ask the AI to build something.</div>
          : results ? (
            results.length === 0 ? <div className="empty big">No files match “{q}”.</div>
              : <div className="flist">{results.map((r) => card(r.path, r.m.positions))}</div>
          ) : <div className="flist">{flat.map((f) => card(f))}</div>}
      </div>
    </div>
  );
}