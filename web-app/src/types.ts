export type Tab = "preview" | "files" | "code" | "layers" | "docs";
export type Device = "desktop" | "tablet" | "mobile";
export type Tool = "browse" | "select" | "text" | "draw" | "comment";
export type ThemePref = "auto" | "light" | "dark";
export type ToolPos = "auto" | "top" | "bottom" | "left" | "right";
export type Dock = "dock" | "minimized" | "hidden";

export type Route = { path: string; label: string };
export type ProjectState = {
  title?: string;
  project: string;
  projects: string[];
  files: string[];
  routes: Route[];
  history: { can_undo: boolean; can_redo: boolean };
  sizes?: Record<string, number>;
  version?: string;
  public_url?: string | null;
  rev?: number;
  blank?: boolean;
  suggest?: string | null;
};
export type VersionEntry = { index: number; path: string; source: string; ts: number; kind: "created" | "edited" | "deleted" };
export type ExportFile = { filename: string; mimeType: string; base64: string };

/** What the inspector inside the preview reports about the clicked element. */
export type Sel = {
  src: string; path: string; line: number; col: number; tag: string; className: string; text: string | null;
  styles: { color: string; backgroundColor: string; fontSize: string; fontWeight: string; padding: string };
  rect: { width: number; height: number };
  click?: { fx: number; fy: number };
};
export type Described = { ok: boolean; tag?: string; className?: string | null; dynamicClassName?: boolean; text?: string | null; error?: string };
export type Changes = { text?: string; textColor?: string; bgColor?: string; padding?: number; fontSize?: number; fontWeight?: string };
export type LayerNode = { src: string; tag: string; depth: number; text: string; cls?: string };
export type Rect = { x: number; y: number; w: number; h: number };
export type SearchMatch = { path: string; line: number; col: number; len: number; text: string };
export type FileData = { path: string; content: string; hash: string; language: string };
export type LiveFile = { path: string; content: string; done: boolean };
export type Comment = { id: number; sel: Sel; text: string };
export type SaveResult = { ok: boolean; hash?: string; conflict?: boolean; current_hash?: string; error?: string };

/* ------------------------------------------------------------------ library, diagrams, charts */
export type LibKind = "text" | "markdown" | "html" | "csv" | "json" | "svg" | "chart" | "diagram" | "image" | "docx" | "xlsx" | "pptx" | "pdf" | "audio" | "video" | "notebook" | "archive" | "other";
export type LibItem = { id: string; name: string; kind: LibKind; mime: string; size: number; source: string; created: number; updated: number; version: number; meta?: Record<string, unknown> };
export type GNode = { id: string; label: string; sub?: string; kind: string; group?: string; file?: string; line?: number; color?: string; x?: number; y?: number };
export type GEdge = { id: string; from: string; to: string; label?: string; dashed?: boolean };
export type GraphSpec = { version: number; kind: "graph"; type: string; title: string; direction?: "LR" | "TB"; groups?: { id: string; label: string }[]; nodes: GNode[]; edges: GEdge[]; generated?: string };
export type Participant = { id: string; label: string; kind: string; file?: string; color?: string };
export type Message = { id: string; from: string; to: string; label: string; kind: "call" | "return" | "self" | "note"; phase?: string };
export type SeqSpec = { version: number; kind: "sequence"; type: string; title: string; participants: Participant[]; messages: Message[]; generated?: string };
export type DiagramSpec = GraphSpec | SeqSpec;
export type ChartType = "bar" | "hbar" | "stacked" | "line" | "area" | "pie" | "donut" | "scatter";
export type ChartSeries = { name: string; values?: (number | null)[]; points?: { x: number; y: number }[]; color?: string };
export type ChartSpec = { version: number; type: ChartType; title: string; subtitle: string; labels: string[]; series: ChartSeries[]; xLabel: string; yLabel: string; legend: boolean; showValues: boolean; grid: boolean; pointColors: Record<string, string> };
export type Run = { t: string; b?: boolean; i?: boolean; c?: boolean; href?: string };
export type Block = { id: string; type: string; runs?: Run[]; level?: number; rows?: string[][]; src?: string; ref?: number; locked?: boolean };
export type Cell = string | number | boolean | null;
export type Sheet = { name: string; rows: Cell[][]; calc?: Cell[][] | null; truncated?: boolean };
export type SlideShape = { id: number; name: string; kind: string; x: number; y: number; w: number; h: number; text?: string; rows?: string[][]; src?: string; fontPt?: number };
export type Slide = { index?: number; shapes: SlideShape[]; notes: string; layout?: string; title?: string; bullets?: string[]; subtitle?: string };
export type StructNode = { name: string; path: string; type: "dir" | "file"; role?: string; roleLabel?: string; size: number; lines: number; files?: number; children?: StructNode[]; components?: string[]; exports?: string[]; imports?: number; importedBy?: number; external?: string[]; unused?: boolean };
export type Problem = { kind: string; severity: "error" | "warning" | "info"; path: string; line: number; message: string };
export type Structure = { project: string; tree: StructNode; problems: Problem[]; summary: { files: number; lines: number; bytes: number; components: number; roles: Record<string, number>; routes: { path: string; component?: string | null }[]; dependencies: Record<string, string>; devDependencies: Record<string, string>; stateVars: number; handlers: number; effects: number } };
/** What the user selected inside a document, so the AI can be asked to change just that section. */
export type DocSelection = { docId: string; docName: string; kind: LibKind; label: string; text?: string; detail?: string };
