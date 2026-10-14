import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Rect } from "./types";

const M = 8;   // minimum distance from the edges of the preview
const GAP = 10; // distance between the element and its bar
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export type Placement = "above" | "below" | "inside" | "free";

/** Where to put a popover of size `size` so that it sits on the element `rect`, fully inside `bounds`. */
export function place(rect: Rect | undefined, size: { w: number; h: number }, bounds: { w: number; h: number }) {
  let left: number, top: number, placement: Placement;
  if (!rect) {
    left = (bounds.w - size.w) / 2; top = bounds.h - size.h - 76; placement = "free";
  } else {
    left = rect.x + rect.w / 2 - size.w / 2;
    top = rect.y - size.h - GAP; placement = "above";
    if (top < M) { top = rect.y + rect.h + GAP; placement = "below"; }
    if (top + size.h > bounds.h - M) { top = rect.y + M; placement = "inside"; }
  }
  return { left: clamp(left, M, bounds.w - size.w - M), top: clamp(top, M, bounds.h - size.h - M), placement };
}

/** Measure a popover and position it on an element; follows the element when it moves or scrolls. */
export function useAnchored(rect: Rect | undefined, bounds: { w: number; h: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const measured = size.w > 0;
  const pos = place(rect, size, bounds);
  const style: CSSProperties = measured ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" };
  return { ref, style, placement: pos.placement };
}
