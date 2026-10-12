import { describe, expect, it } from "vitest";
import { Doc } from "../crdt/doc";
import { arrowEnds, create, hit, shapesOf, simplify, wrap, type Shape } from "./model";

const rect = (id: string, x: number, y: number): Shape => ({ id, type: "rect", x, y, w: 100, h: 50, color: "ink", z: 1 });

describe("board model", () => {
  it("round-trips a shape through the CRDT", () => {
    const d = new Doc("a");
    const { id, edits } = create({ type: "note", x: 10, y: 20, w: 160, h: 120, text: "hi", color: "ember", z: 1 });
    d.change(edits);
    const [s] = shapesOf(d.state());
    expect(s).toMatchObject({ id, type: "note", x: 10, y: 20, text: "hi", color: "ember" });
  });

  it("ignores a shape whose type has not arrived yet", () => {
    const d = new Doc("a");
    d.change([{ shape: "s", field: "x", value: 1 }]);
    expect(shapesOf(d.state())).toEqual([]);
  });

  it("pins arrow ends to the edges of their shapes", () => {
    const a = rect("a", 0, 0);
    const b = rect("b", 300, 0);
    const arrow: Shape = { id: "x", type: "arrow", x: 0, y: 0, w: 0, h: 0, from: { shape: "a", x: 0, y: 0 }, to: { shape: "b", x: 0, y: 0 }, color: "ink", z: 2 };
    const [p, q] = arrowEnds(arrow, new Map([["a", a], ["b", b]]));
    expect(p.x).toBeCloseTo(106); // right edge of a, plus the gap
    expect(q.x).toBeCloseTo(294); // left edge of b, minus the gap
    expect(p.y).toBeCloseTo(25);
  });

  it("falls back to the stored point when the pinned shape is gone", () => {
    const arrow: Shape = { id: "x", type: "arrow", x: 0, y: 0, w: 0, h: 0, from: { shape: "gone", x: 5, y: 6 }, to: { x: 50, y: 60 }, color: "ink", z: 2 };
    expect(arrowEnds(arrow, new Map())).toEqual([{ x: 5, y: 6 }, { x: 50, y: 60 }]);
  });

  it("hits rectangles, ellipses and strokes", () => {
    const m = new Map<string, Shape>();
    expect(hit(rect("r", 0, 0), 50, 25, 0, m)).toBe(true);
    expect(hit(rect("r", 0, 0), 150, 25, 0, m)).toBe(false);
    const e: Shape = { ...rect("e", 0, 0), type: "ellipse" };
    expect(hit(e, 2, 2, 0, m)).toBe(false); // the corner is outside the ellipse
    const pen: Shape = { ...rect("p", 0, 0), type: "pen", points: [0, 0, 100, 0] };
    expect(hit(pen, 50, 2, 1, m)).toBe(true);
    expect(hit(pen, 50, 20, 1, m)).toBe(false);
  });

  it("simplifies strokes but keeps both ends", () => {
    const pts = [0, 0, 0.5, 0, 1, 0, 10, 0, 10.2, 0];
    const s = simplify(pts);
    expect(s.slice(0, 2)).toEqual([0, 0]);
    expect(s.slice(-2)).toEqual([10.2, 0]);
    expect(s.length).toBeLessThan(pts.length);
  });

  it("wraps text to a width", () => {
    expect(wrap("one two three", 7, (s) => s.length)).toEqual(["one two", "three"]);
  });
});
