import type { DocSelection, LibItem } from "../../types";
import type { Env } from "./env";

/** What every editor receives: the payload from forge_ui_lib_get and a way to change it. */
export type EditorProps = {
  item: LibItem;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  onChange: (p: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  env: Env;
  readOnly: boolean;
};
export type { DocSelection };
export const dataUrl = (mime: string, b64: string) => `data:${mime};base64,${b64}`;
export const b64Of = (url: string) => url.split(",", 2)[1] ?? "";
