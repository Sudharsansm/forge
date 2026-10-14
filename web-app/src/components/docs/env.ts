import type { DocSelection, ExportFile } from "../../types";

/** What every viewer/editor needs from the workbench. */
export type Env = {
  dark: boolean;
  say: (m: string) => void;
  download: (f: ExportFile) => Promise<void>;
  /** Ask the AI to change the selected section. */
  ask: (instruction: string, sel: DocSelection | null) => void;
  canAsk: boolean;
  /** The AI is the host's own chat: selections are shared as context and the user types the change there. */
  hostChat?: boolean;
  askLabel: string;
  /** Tell the workbench what is selected (kept for the AI's forge_get_doc_selection). */
  onSelection: (s: DocSelection | null) => void;
  openFile: (path: string, line?: number) => void;
  /** Inside an AI app: put a short chip (e.g. "⬚ p") in the host's chat box and share the details as model context. */
  postChip?: (tag: string, context: string) => void;
  /** Send a prepared message (and optional pictures) to the AI: the host's chat in an AI app, the clipboard standalone. */
  setContext?: (text: string) => void;
  post?: (text: string, images?: { mimeType: string; base64: string }[]) => Promise<boolean>;
};
