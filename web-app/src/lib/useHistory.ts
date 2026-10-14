import { useCallback, useRef, useState } from "react";

/** Undo/redo for a value held by the parent. `commit` coalesces rapid edits that share a key (typing in a field). */
export function useHistory<T>(value: T, set: (v: T) => void) {
  const past = useRef<T[]>([]), future = useRef<T[]>([]);
  const last = useRef<{ key: string; at: number } | null>(null);
  const [, bump] = useState(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const commit = useCallback((next: T, key?: string) => {
    const now = Date.now();
    if (!(key && last.current && last.current.key === key && now - last.current.at < 900)) {
      past.current.push(valueRef.current);
      if (past.current.length > 60) past.current.shift();
    }
    last.current = key ? { key, at: now } : null;
    future.current = [];
    set(next); bump((n) => n + 1);
  }, [set]);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(valueRef.current); last.current = null; set(prev); bump((n) => n + 1);
  }, [set]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(valueRef.current); last.current = null; set(next); bump((n) => n + 1);
  }, [set]);
  const reset = useCallback(() => { past.current = []; future.current = []; last.current = null; bump((n) => n + 1); }, []);
  return { commit, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
