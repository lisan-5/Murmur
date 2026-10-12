/** What lives on a board, and the geometry to draw and hit it. Pure functions, no DOM. */

export type Kind = "rect" | "ellipse" | "note" | "text" | "pen" | "arrow";
export type Ink = "ink" | "ember" | "moss" | "sky" | "plum";
export const INKS: Ink[] = ["ink", "ember", "moss", "sky", "plum"];

/** An arrow end: pinned to a shape (it follows it) or loose at a point. */
export type End = { shape?: string; x: number; y: number };

export type Shape = {
  id: string;
  type: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** pen: flat [x0, y0, x1, y1, ...] relative to x, y */
  points?: number[];
  from?: End;
  to?: End;
  text?: string;
  color: Ink;
  z: number;
};

export type Edit = { shape: string; field: string; value: unknown };

const FIELDS = ["type", "x", "y", "w", "h", "points", "from", "to", "text", "color", "z"] as const;

/** Turn the CRDT's raw state into shapes, bottom to top. Skips half-arrived shapes (no type yet). */
export function shapesOf(state: Record<string, Record<string, unknown>>): Shape[] {
  const out: Shape[] = [];
  for (const id in state) {
    const s = state[id];
    if (typeof s.type !== "string") continue;
    out.push({
      id,
      type: s.type as Kind,
      x: num(s.x),
      y: num(s.y),
      w: num(s.w),
      h: num(s.h),
      points: Array.isArray(s.points) ? (s.points as number[]) : undefined,
      from: s.from as End | undefined,
      to: s.to as End | undefined,
      text: typeof s.text === "string" ? s.text : undefined,
      color: (INKS.includes(s.color as Ink) ? s.color : "ink") as Ink,
      z: num(s.z),
    });
  }
  return out.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The edits that create a shape: one per field. */
export function create(shape: Omit<Shape, "id"> & { id?: string }): { id: string; edits: Edit[] } {
  const id = shape.id ?? newId();
  const edits: Edit[] = [];
  for (const f of FIELDS) {
    const v = (shape as Record<string, unknown>)[f];
    if (v !== undefined) edits.push({ shape: id, field: f, value: v });
  }
  return { id, edits };
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** A z above everything, unique enough that two people adding at once do not tie. */
export const topZ = (shapes: Shape[]) => (shapes.length ? shapes[shapes.length - 1].z : 0) + 1 + Math.random() * 0.001;

export type Box = { x: number; y: number; w: number; h: number };

export function box(s: Shape, byId: Map<string, Shape>): Box {
  if (s.type === "arrow") {
    const [a, b] = arrowEnds(s, byId);
    return norm({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
  }
  return norm({ x: s.x, y: s.y, w: s.w, h: s.h });
}

export function norm(b: Box): Box {
  return { x: Math.min(b.x, b.x + b.w), y: Math.min(b.y, b.y + b.h), w: Math.abs(b.w), h: Math.abs(b.h) };
}

export const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where an arrow actually starts and ends: pinned ends sit on the edge of their shape, facing the other end. */
export function arrowEnds(s: Shape, byId: Map<string, Shape>): [{ x: number; y: number }, { x: number; y: number }] {
  const raw = (e: End | undefined) => {
    const target = e?.shape ? byId.get(e.shape) : undefined;
    if (target && target.type !== "arrow") return { pt: centre(norm(target)), box: norm(target) };
    return { pt: { x: e?.x ?? s.x, y: e?.y ?? s.y }, box: null };
  };
  const a = raw(s.from);
  const b = raw(s.to);
  const pa = a.box ? edge(a.box, a.pt, b.pt) : a.pt;
  const pb = b.box ? edge(b.box, b.pt, a.pt) : b.pt;
  return [pa, pb];
}

/** The point where the line from the centre of `b` toward `toward` leaves the box, plus a small gap. */
function edge(b: Box, c: { x: number; y: number }, toward: { x: number; y: number }) {
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  const gap = 6 / Math.hypot(dx, dy);
  return { x: c.x + dx * (t + gap), y: c.y + dy * (t + gap) };
}

/** Is world point (px, py) on this shape? `tol` is in world units. */
export function hit(s: Shape, px: number, py: number, tol: number, byId: Map<string, Shape>): boolean {
  if (s.type === "arrow") {
    const [a, b] = arrowEnds(s, byId);
    return segDist(px, py, a.x, a.y, b.x, b.y) <= tol + 2;
  }
  if (s.type === "pen" && s.points) {
    const p = s.points;
    for (let i = 2; i < p.length; i += 2) {
      if (segDist(px, py, s.x + p[i - 2], s.y + p[i - 1], s.x + p[i], s.y + p[i + 1]) <= tol + 3) return true;
    }
    return false;
  }
  const b = norm(s);
  if (s.type === "ellipse") {
    const rx = b.w / 2 + tol;
    const ry = b.h / 2 + tol;
    const dx = px - (b.x + b.w / 2);
    const dy = py - (b.y + b.h / 2);
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }
  return px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export const overlaps = (a: Box, b: Box) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

export const snap = (v: number, on: boolean, grid = 8) => (on ? Math.round(v / grid) * grid : v);

/** Simplify a freehand stroke (radial distance), so long strokes stay light on the wire. */
export function simplify(pts: number[], min = 2.5): number[] {
  if (pts.length <= 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const lx = out[out.length - 2];
    const ly = out[out.length - 1];
    if (Math.hypot(pts[i] - lx, pts[i + 1] - ly) >= min) out.push(pts[i], pts[i + 1]);
  }
  const lx = pts[pts.length - 2];
  const ly = pts[pts.length - 1];
  if (out[out.length - 2] !== lx || out[out.length - 1] !== ly) out.push(lx, ly);
  return out;
}

/** Word-wrap for notes and text. `measure` gives the width of a string. */
export function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}
