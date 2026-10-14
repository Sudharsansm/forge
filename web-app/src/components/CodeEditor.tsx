import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { useEffect, useRef } from "react";

function lang(name: string) {
  switch (name) {
    case "tsx": case "typescript": return javascript({ jsx: true, typescript: true });
    case "jsx": case "javascript": return javascript({ jsx: true });
    case "css": return css();
    case "html": return html();
    case "json": return json();
    default: return [];
  }
}

type Props = {
  docKey: string; value: string; language: string; dark: boolean;
  readOnly?: boolean; follow?: boolean; reveal?: { line: number; nonce: number } | null;
  onChange?: (v: string) => void; onSave?: () => void;
};

/** CodeMirror 6 (Monaco cannot load inside a locked-down MCP App iframe). Remounts when docKey changes. */
export function CodeEditor({ docKey, value, language, dark, readOnly, follow, reveal, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const themeC = useRef(new Compartment());
  const langC = useRef(new Compartment());
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const initial = useRef({ value, language, dark });
  initial.current = { value, language, dark };

  useEffect(() => {
    const i = initial.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: i.value,
        extensions: [
          basicSetup,
          langC.current.of(lang(i.language)),
          themeC.current.of(i.dark ? oneDark : []),
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(!!readOnly),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { cb.current.onSave?.(); return true; } }]),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange?.(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, [docKey, readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
      if (follow) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.length, { y: "end" }) });
    }
  }, [value, follow]);

  useEffect(() => { view.current?.dispatch({ effects: themeC.current.reconfigure(dark ? oneDark : []) }); }, [dark]);
  useEffect(() => { view.current?.dispatch({ effects: langC.current.reconfigure(lang(language)) }); }, [language]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const line = v.state.doc.line(Math.max(1, Math.min(reveal.line, v.state.doc.lines)));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  }, [reveal, docKey]);

  return <div className="cm-host" ref={host} />;
}
