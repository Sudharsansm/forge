import { useMemo } from "react";
import { Icon } from "./Icon";
import { Highlight } from "./Highlight";
import { fuzzy } from "../util";
import { CodeEditor } from "./CodeEditor";
import { FileTree } from "./FileTree";
import type { FileData, LiveFile, SearchMatch } from "../types";

const lang = (p: string) => (p.endsWith(".tsx") ? "tsx" : p.endsWith(".ts") ? "typescript" : p.endsWith(".css") ? "css"
  : p.endsWith(".json") ? "json" : p.endsWith(".html") ? "html" : p.endsWith(".jsx") ? "jsx" : p.endsWith(".js") ? "javascript" : "text");

type Props = {
  files: string[]; sizes: Record<string, number>; file: FileData | null; draft: string; dirty: boolean; dark: boolean;
  touched: Record<string, number>; reveal: { line: number; nonce: number } | null;
  conflict: boolean; saving: boolean;
  live: LiveFile[]; liveActive: string | null; streaming: boolean;
  query: string; results: { matches: SearchMatch[]; truncated: boolean; files: number } | null; searching: boolean;
  onOpen: (p: string, line?: number) => void; onChange: (v: string) => void; onSave: () => void; onRevert: () => void;
  onLoadTheirs: () => void; onOverwrite: () => void; onCopy: () => void; onDownloadFile: () => void;
};

/** Code tab: folder tree + editor. While the AI is writing, the file being generated streams in here, read-only. */
export function CodeWorkspace(p: Props) {
  // While the AI writes, and until a real file is open afterwards, show the AI's files so the tab is never empty.
  const showLive = p.live.length > 0 && (p.streaming || !p.file);
  const liveFile = showLive ? p.live.find((f) => f.path === p.liveActive) ?? p.live[p.live.length - 1] : undefined;
  const writing = new Set(p.streaming ? p.live.filter((f) => !f.done).map((f) => f.path) : []);
  const searching = p.query.trim().length > 0;
  const treeFiles = showLive ? [...new Set([...p.files, ...p.live.map((f) => f.path)])] : p.files;
  return (
    <div className="split">
      <aside className={`tree${searching ? " wide" : ""}`}>
        {searching ? <SearchResults query={p.query} files={p.files} results={p.results} searching={p.searching} onOpen={p.onOpen} /> : (
          <FileTree files={treeFiles} sizes={p.sizes} touched={p.touched} writing={writing}
            active={liveFile?.path ?? p.file?.path ?? null} onOpen={(path) => p.onOpen(path)} />
        )}
      </aside>
      <section className="editor-col">
        {liveFile ? (
          <>
            <div className="editor-head ai-writing">
              {p.streaming ? <span className="spinner xs" /> : <span className="okmark">✓</span>} <b>{p.streaming ? "AI is writing" : "AI wrote"}</b> <span className="path">{liveFile.path}</span>
            </div>
            <div className="editor-body">
              <CodeEditor docKey={`live:${liveFile.path}`} value={liveFile.content} language={lang(liveFile.path)} dark={p.dark} readOnly follow />
            </div>
          </>
        ) : (
          <>
            <div className="editor-head">
              <span className="path">{p.file ? p.file.path : "Select a file"}{p.dirty ? " •" : ""}</span>
              <span className="grow" />
              <button className="icon-btn" title="Copy file" disabled={!p.file} onClick={p.onCopy}><Icon name="copy" size={16} /></button>
              <button className="icon-btn" title="Download file" disabled={!p.file} onClick={p.onDownloadFile}><Icon name="filedl" size={17} /></button>
              <button disabled={!p.dirty} onClick={p.onRevert}>Revert</button>
              <button className="primary" disabled={!p.dirty || p.saving} onClick={p.onSave}>Save</button>
            </div>
            {p.conflict ? (
              <div className="banner warn-banner">
                This file was changed (by the AI or elsewhere) since you opened it.
                <button onClick={p.onLoadTheirs}>Load their version</button>
                <button onClick={p.onOverwrite}>Overwrite with mine</button>
              </div>
            ) : null}
            <div className="editor-body">
              {p.file ? (
                <CodeEditor docKey={p.file.path} value={p.draft} language={p.file.language} dark={p.dark}
                  reveal={p.reveal} onChange={p.onChange} onSave={p.onSave} />
              ) : <div className="empty">Pick a file to view or edit it. Press Ctrl/⌘+S to save.</div>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}


type SRProps = { query: string; files: string[]; results: Props["results"]; searching: boolean; onOpen: (p: string, line?: number) => void };

/** Code search: file names (fuzzy, like VS Code quick open) and text inside the files, grouped by file. */
function SearchResults({ query, files, results, searching, onOpen }: SRProps) {
  const q = query.trim();
  const nameHits = useMemo(() => files.map((path) => ({ path, m: fuzzy(q, path) }))
    .filter((r): r is { path: string; m: NonNullable<ReturnType<typeof fuzzy>> } => r.m !== null)
    .sort((a, b) => b.m.score - a.m.score).slice(0, 8), [files, q]);
  const groups = useMemo(() => {
    const by = new Map<string, SearchMatch[]>();
    results?.matches.forEach((m) => by.set(m.path, [...(by.get(m.path) ?? []), m]));
    return [...by.entries()];
  }, [results]);
  return (
    <div className="results">
      {nameHits.length ? <div className="res-title">Files</div> : null}
      {nameHits.map(({ path, m }) => (
        <button key={path} className="res-file" onClick={() => onOpen(path)} title={path}>
          <Icon name="file" size={14} /><span className="res-name"><Highlight text={path} positions={m.positions} /></span>
        </button>
      ))}
      <div className="res-title">In code{results ? ` · ${results.matches.length}${results.truncated ? "+" : ""} match${results.matches.length === 1 ? "" : "es"} in ${results.files} file${results.files === 1 ? "" : "s"}` : searching ? " · searching…" : ""}</div>
      {q.length < 2 ? <div className="res-empty">Type at least 2 characters to search inside files.</div> : null}
      {q.length >= 2 && results && results.matches.length === 0 && !searching ? <div className="res-empty">No matches in the code.</div> : null}
      {groups.map(([path, ms]) => (
        <div key={path} className="res-group">
          <div className="res-path" title={path}>{path}<span>{ms.length}</span></div>
          {ms.map((m, i) => (
            <button key={i} className="res-line" onClick={() => onOpen(path, m.line)}>
              <span className="ln">{m.line}</span>
              <span className="code"><Highlight text={m.text} positions={Array.from({ length: m.len }, (_, k) => m.col + k)} /></span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
