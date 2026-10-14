import { describe, expect, it } from "vitest";
import { layoutGraph, layoutSequence, ranks } from "../graph";
import { arc, niceTicks, fmt, dataRange } from "../chart";
import { mdToHtml } from "../md";
import type { ChartSpec, GraphSpec, SeqSpec } from "../../types";

const g = (edges: [string, string][], ids = ["a", "b", "c"]): GraphSpec => ({
  version: 1, kind: "graph", type: "workflow", title: "t",
  nodes: ids.map((id) => ({ id, label: id, kind: "process" })), edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })),
});

describe("graph layout", () => {
  it("ranks a chain left to right", () => { expect(ranks(g([["a", "b"], ["b", "c"]]))).toEqual({ a: 0, b: 1, c: 2 }); });
  it("terminates on cycles and marks the back edge", () => {
    const l = layoutGraph(g([["a", "b"], ["b", "c"], ["c", "a"]]));
    expect(l.edges.filter((e) => e.back)).toHaveLength(1);
    expect(Object.keys(l.nodes)).toHaveLength(3);
  });
  it("never overlaps nodes in the same rank", () => {
    const l = layoutGraph(g([["a", "b"], ["a", "c"]]));
    const [b, c] = [l.nodes.b, l.nodes.c];
    expect(b.x === c.x ? Math.abs(b.y - c.y) >= b.h : true).toBe(true);
  });
  it("honours a manual position", () => {
    const s = g([["a", "b"]]); s.nodes[0].x = 500; s.nodes[0].y = 300;
    expect(layoutGraph(s).nodes.a).toMatchObject({ x: 500, y: 300 });
  });
  it("ignores edges to unknown nodes", () => { expect(() => layoutGraph(g([["a", "zzz"]]))).not.toThrow(); });
  it("lays out sequence diagrams", () => {
    const s: SeqSpec = { version: 1, kind: "sequence", type: "sequence", title: "s", participants: [{ id: "u", label: "User", kind: "user" }, { id: "s", label: "Server", kind: "service" }],
      messages: [{ id: "m1", from: "u", to: "s", label: "go", kind: "call" }, { id: "m2", from: "s", to: "u", label: "ok", kind: "return" }] };
    const l = layoutSequence(s);
    expect(l.height).toBeGreaterThan(100);
  });
});

describe("chart maths", () => {
  it("makes nice ticks that cover the data", () => {
    const t = niceTicks(0, 87);
    expect(t.lo).toBe(0); expect(t.hi).toBeGreaterThanOrEqual(87); expect(t.ticks.length).toBeGreaterThan(2);
  });
  it("handles a flat range", () => { const t = niceTicks(5, 5); expect(t.hi).toBeGreaterThan(t.lo); });
  it("formats big numbers", () => { expect(fmt(12500)).toBe("12.5k"); expect(fmt(2_500_000)).toBe("2.5M"); expect(fmt(3.14159)).toBe("3.14"); });
  it("builds a donut path", () => { expect(arc(100, 100, 50, 25, 0, 1)).toMatch(/^M.*A.*L.*A.*Z$/); });
  it("stacks values for the range", () => {
    const spec = { type: "stacked", labels: ["a"], series: [{ name: "x", values: [3] }, { name: "y", values: [4] }], pointColors: {} } as unknown as ChartSpec;
    expect(dataRange(spec).max).toBe(7);
  });
});

describe("markdown renderer", () => {
  it("escapes raw HTML", () => { expect(mdToHtml("<script>alert(1)</script>")).not.toContain("<script>"); });
  it("blocks javascript: links", () => { expect(mdToHtml("[x](javascript:alert(1))")).not.toContain("href"); });
  it("allows https links with rel", () => { expect(mdToHtml("[x](https://a.b)")).toContain('rel="noopener noreferrer"'); });
  it("renders headings, lists and tables", () => {
    const h = mdToHtml("# T\n\n- a\n- b\n\n| h |\n|---|\n| c |");
    expect(h).toContain("<h1>T</h1>"); expect(h).toContain("<ul>"); expect(h).toContain("<table>");
  });
  it("keeps code blocks verbatim", () => { expect(mdToHtml("```\n<b>x</b>\n```")).toContain("&lt;b&gt;x&lt;/b&gt;"); });
});

import { bbox, buildPrompt, probePoints, shapeOf } from "../annotate";
describe("annotate", () => {
  const circle = Array.from({ length: 40 }, (_, i) => ({ x: 100 + 50 * Math.cos((i / 39) * 2 * Math.PI), y: 100 + 50 * Math.sin((i / 39) * 2 * Math.PI) }));
  const line = Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: i * 5 }));
  it("tells a loop from a line", () => { expect(shapeOf(circle)).toBe("circled area"); expect(shapeOf(line)).toBe("line or arrow"); });
  it("computes a bounding box", () => { expect(bbox(line)).toEqual({ x: 0, y: 0, w: 90, h: 45 }); });
  it("probes along the mark and across its box, capped", () => {
    const pts = probePoints([circle, line]);
    expect(pts.length).toBeLessThanOrEqual(60); expect(pts.some((p) => p.s === 1)).toBe(true);
  });
  it("builds a prompt naming the element, file and line", () => {
    const text = buildPrompt({ project: "p", route: "/", device: "desktop", vw: 1000, vh: 500, strokes: [circle],
      hits: [[{ src: "src/A.tsx:4:2", path: "src/A.tsx", line: 4, tag: "h1", text: "Hello", rect: { x: 0, y: 0, w: 10, h: 10 } }]], instruction: "make it red" });
    expect(text).toContain("<h1> “Hello” at src/A.tsx:4"); expect(text).toContain("make it red"); expect(text).toContain("circled area");
  });
});
