/**
 * The board: one canvas, an infinite plane under a pan/zoom camera.
 * It renders whatever Doc it is given (the live one, or a replay from the timeline) and turns
 * pointer and keyboard input into CRDT edits. Peers' cursors fly over it as small birds.
 */
import { useEffect, useRef, useState } from "react";
import type { Doc } from "../crdt/doc";
import type { Presence } from "../net/protocol";
import { arrowEnds, box, create, hit, norm, overlaps, shapesOf, simplify, snap, topZ, wrap, type Box, type Edit, type End, type Ink, type Shape } from "./model";

export type Tool = "select" | "hand" | "rect" | "ellipse" | "arrow" | "pen" | "text" | "note";

type Props = {
  doc: Doc;
  /** when set, the board shows this instead and cannot be edited (timeline replay) */
  view: Doc | null;
  tool: Tool;
  setTool: (t: Tool) => void;
  ink: Ink;
  peers: Presence[];
  me: { replica: string; color: string };
  onCursor: (pt: { x: number; y: number } | null) => void;
  onSelection: (ids: string[]) => void;
  /** bumped when the theme changes, so colours are re-read */
  themeKey: string;
};

type Cam = { x: number; y: number; z: number };
type Drag =
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "move"; sx: number; sy: number; start: Map<string, { x: number; y: number; from?: End; to?: End }>; moved: boolean }
  | { kind: "resize"; id: string; corner: number; start: Box }
  | { kind: "marquee"; sx: number; sy: number; x: number; y: number }
  | { kind: "make"; id: string; type: Shape["type"]; sx: number; sy: number }
  | { kind: "pen"; pts: number[] }
  | { kind: "arrow"; from: End; x: number; y: number };

type History = { undo: Edit[][]; redo: Edit[][] };

export function Board({ doc, view, tool, setTool, ink, peers, me, onCursor, onSelection, themeKey }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Cam>({ x: 0, y: 0, z: 1 });
  const sel = useRef<string[]>([]);
  const drag = useRef<Drag | null>(null);
  const dirty = useRef(true);
  const cache = useRef<{ shapes: Shape[]; byId: Map<string, Shape> } | null>(null);
  const hist = useRef<History>({ undo: [], redo: [] });
  const space = useRef(false);
  const palette = useRef<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [, force] = useState(0);
  const source = view ?? doc;
  const src = useRef(source);
  src.current = source;
  const latest = useRef({ tool, ink, peers, me, view, editing });
  latest.current = { tool, ink, peers, me, view, editing };

  /* ── state ─────────────────────────────────────────────────────────── */
  const shapes = () => {
    if (!cache.current) {
      const list = shapesOf(src.current.state());
      cache.current = { shapes: list, byId: new Map(list.map((s) => [s.id, s])) };
    }
    return cache.current;
  };
  const invalidate = () => {
    cache.current = null;
    dirty.current = true;
  };
  useEffect(() => {
    invalidate();
    return source.onChange(invalidate);
  }, [source]);
  useEffect(() => {
    dirty.current = true;
  }, [peers, tool]);

  /** Apply edits; unless `quiet`, remember how to undo them. */
  const commit = (edits: Edit[], quiet = false) => {
    if (!edits.length || latest.current.view) return;
    if (!quiet) {
      hist.current.undo.push(inverse(doc, edits));
      hist.current.redo = [];
    }
    doc.change(edits);
  };
  const select = (ids: string[]) => {
    sel.current = ids;
    onSelection(ids);
    dirty.current = true;
  };

  /* ── colours, read from the theme ──────────────────────────────────── */
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    palette.current = { bg: v("--bg"), line: v("--line"), grid: v("--grid"), ink: v("--ink"), ember: v("--ember"), moss: v("--moss"), sky: v("--sky"), plum: v("--plum"), accent: v("--accent"), soft: v("--ink-3") };
    dirty.current = true;
  }, [themeKey]);

  /* ── coordinates ───────────────────────────────────────────────────── */
  const toWorld = (sx: number, sy: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const c = cam.current;
    return { x: (sx - r.left) / c.z + c.x, y: (sy - r.top) / c.z + c.y };
  };
  const toScreen = (x: number, y: number) => {
    const c = cam.current;
    return { x: (x - c.x) * c.z, y: (y - c.y) * c.z };
  };
  const topAt = (x: number, y: number) => {
    const { shapes: list, byId } = shapes();
    const tol = 4 / cam.current.z;
    for (let i = list.length - 1; i >= 0; i--) if (hit(list[i], x, y, tol, byId)) return list[i];
    return null;
  };
  const handleAt = (x: number, y: number): number => {
    if (sel.current.length !== 1) return -1;
    const s = shapes().byId.get(sel.current[0]);
    if (!s || s.type === "arrow" || s.type === "pen") return -1;
    const b = norm(s);
    const r = 7 / cam.current.z;
    const corners = [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h],
    ];
    return corners.findIndex(([cx, cy]) => Math.abs(x - cx) <= r && Math.abs(y - cy) <= r);
  };

  /* ── drawing ───────────────────────────────────────────────────────── */
  useEffect(() => {
    let raf = 0;
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const fit = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      el.width = Math.round(el.clientWidth * dpr);
      el.height = Math.round(el.clientHeight * dpr);
      dirty.current = true;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!dirty.current) return;
      dirty.current = false;
      draw(ctx, el);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // draw reads everything through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = (ctx: CanvasRenderingContext2D, el: HTMLCanvasElement) => {
    const P = palette.current;
    const dpr = el.width / el.clientWidth || 1;
    const c = cam.current;
    const W = el.clientWidth;
    const H = el.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // the ground: faint horizon lines, like ruled sky, that scale with zoom
    const step = 64 * c.z;
    if (step > 14) {
      ctx.strokeStyle = P.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const oy = (-c.y * c.z) % step;
      for (let y = oy; y < H; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(W, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }

    ctx.setTransform(dpr * c.z, 0, 0, dpr * c.z, -c.x * c.z * dpr, -c.y * c.z * dpr);
    const view: Box = { x: c.x, y: c.y, w: W / c.z, h: H / c.z };
    const { shapes: list, byId } = shapes();
    const lw = 1 / c.z;
    for (const s of list) {
      const b = box(s, byId);
      if (!overlaps(b, { x: view.x - 20, y: view.y - 20, w: view.w + 40, h: view.h + 40 })) continue;
      drawShape(ctx, s, byId, P, lw, latest.current.editing === s.id);
    }

    // previews of what is being drawn right now
    const d = drag.current;
    if (d?.kind === "pen" && d.pts.length > 2) {
      ctx.strokeStyle = P[latest.current.ink];
      ctx.lineWidth = 2.2;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(d.pts[0], d.pts[1]);
      for (let i = 2; i < d.pts.length; i += 2) ctx.lineTo(d.pts[i], d.pts[i + 1]);
      ctx.stroke();
    }
    if (d?.kind === "arrow") {
      const tmp: Shape = { id: "_", type: "arrow", x: 0, y: 0, w: 0, h: 0, from: d.from, to: { x: d.x, y: d.y }, color: latest.current.ink, z: 0 };
      drawShape(ctx, tmp, byId, P, lw, false);
    }

    // other people's selections, dashed in their colour
    ctx.setLineDash([6 * lw, 5 * lw]);
    for (const p of latest.current.peers) {
      if (p.replica === latest.current.me.replica) continue;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.5 * lw;
      for (const id of p.selection) {
        const s = byId.get(id);
        if (!s) continue;
        const b = box(s, byId);
        ctx.strokeRect(b.x - 6 * lw, b.y - 6 * lw, b.w + 12 * lw, b.h + 12 * lw);
      }
    }
    ctx.setLineDash([]);

    // mine, solid, with handles
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 1.5 * lw;
    for (const id of sel.current) {
      const s = byId.get(id);
      if (!s) continue;
      const b = box(s, byId);
      ctx.strokeRect(b.x - 4 * lw, b.y - 4 * lw, b.w + 8 * lw, b.h + 8 * lw);
    }
    if (sel.current.length === 1) {
      const s = byId.get(sel.current[0]);
      if (s && s.type !== "arrow" && s.type !== "pen") {
        const b = norm(s);
        ctx.fillStyle = P.bg;
        for (const [hx, hy] of [
          [b.x, b.y],
          [b.x + b.w, b.y],
          [b.x + b.w, b.y + b.h],
          [b.x, b.y + b.h],
        ]) {
          ctx.fillRect(hx - 4 * lw, hy - 4 * lw, 8 * lw, 8 * lw);
          ctx.strokeRect(hx - 4 * lw, hy - 4 * lw, 8 * lw, 8 * lw);
        }
      }
    }
    if (d?.kind === "marquee") {
      ctx.fillStyle = P.accent + "18";
      ctx.strokeStyle = P.accent;
      const m = norm({ x: d.sx, y: d.sy, w: d.x - d.sx, h: d.y - d.sy });
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeRect(m.x, m.y, m.w, m.h);
    }

    // the flock: everyone else's cursor, as a small bird in flight
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const p of latest.current.peers) {
      if (!p.cursor || p.replica === latest.current.me.replica) continue;
      const s = toScreen(p.cursor.x, p.cursor.y);
      if (s.x < -40 || s.y < -40 || s.x > W + 40 || s.y > H + 40) continue;
      drawBird(ctx, s.x, s.y, p.color, p.offline || !!p.quiet);
      ctx.font = "500 11px 'Martian Mono', monospace";
      const label = p.offline ? `${p.name} · in a storm` : p.name;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = p.color;
      roundRect(ctx, s.x + 14, s.y + 12, tw + 14, 20, 10);
      ctx.fill();
      ctx.fillStyle = "#14161d";
      ctx.fillText(label, s.x + 21, s.y + 26);
    }
  };

  /* ── input ─────────────────────────────────────────────────────────── */
  const onPointerDown = (e: React.PointerEvent) => {
    if (latest.current.editing) return;
    const el = canvas.current!;
    el.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const t = latest.current.tool;
    const free = e.altKey; // hold Alt to place without snapping

    if (e.button === 1 || t === "hand" || space.current) {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: cam.current.x, cy: cam.current.y };
      return;
    }
    if (latest.current.view) return; // replaying: look, do not touch

    if (t === "select") {
      const corner = handleAt(w.x, w.y);
      if (corner >= 0) {
        const s = shapes().byId.get(sel.current[0])!;
        drag.current = { kind: "resize", id: s.id, corner, start: norm(s) };
        hist.current.undo.push(inverse(doc, [
          { shape: s.id, field: "x", value: 0 },
          { shape: s.id, field: "y", value: 0 },
          { shape: s.id, field: "w", value: 0 },
          { shape: s.id, field: "h", value: 0 },
        ]));
        hist.current.redo = [];
        return;
      }
      const top = topAt(w.x, w.y);
      if (top) {
        let ids = sel.current;
        if (e.shiftKey) ids = ids.includes(top.id) ? ids.filter((i) => i !== top.id) : [...ids, top.id];
        else if (!ids.includes(top.id)) ids = [top.id];
        select(ids);
        const { byId } = shapes();
        const start = new Map<string, { x: number; y: number; from?: End; to?: End }>();
        for (const id of ids) {
          const s = byId.get(id);
          if (s) start.set(id, { x: s.x, y: s.y, from: s.from, to: s.to });
        }
        drag.current = { kind: "move", sx: w.x, sy: w.y, start, moved: false };
      } else {
        if (!e.shiftKey) select([]);
        drag.current = { kind: "marquee", sx: w.x, sy: w.y, x: w.x, y: w.y };
      }
      return;
    }

    if (t === "pen") {
      drag.current = { kind: "pen", pts: [w.x, w.y] };
      return;
    }
    if (t === "arrow") {
      const on = topAt(w.x, w.y);
      drag.current = { kind: "arrow", from: on && on.type !== "arrow" ? { shape: on.id, x: w.x, y: w.y } : { x: w.x, y: w.y }, x: w.x, y: w.y };
      return;
    }
    // boxes: rect, ellipse, note, text
    const x = snap(w.x, !free);
    const y = snap(w.y, !free);
    const size = t === "note" ? { w: 176, h: 136 } : t === "text" ? { w: 220, h: 34 } : { w: 1, h: 1 };
    const { id, edits } = create({ type: t, x, y, ...size, text: t === "note" || t === "text" ? "" : undefined, color: latest.current.ink, z: topZ(shapes().shapes) });
    commit(edits);
    select([id]);
    drag.current = { kind: "make", id, type: t, sx: x, sy: y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    onCursor(w);
    const d = drag.current;
    if (!d) {
      const el = canvas.current!;
      const t = latest.current.tool;
      el.style.cursor = t === "hand" || space.current ? "grab" : t === "select" ? (handleAt(w.x, w.y) >= 0 ? "nwse-resize" : topAt(w.x, w.y) ? "move" : "default") : "crosshair";
      return;
    }
    const free = e.altKey;
    switch (d.kind) {
      case "pan": {
        const c = cam.current;
        c.x = d.cx - (e.clientX - d.sx) / c.z;
        c.y = d.cy - (e.clientY - d.sy) / c.z;
        break;
      }
      case "move": {
        const dx = snap(w.x - d.sx, !free);
        const dy = snap(w.y - d.sy, !free);
        if (!d.moved && Math.hypot(dx, dy) < 2) break;
        if (!d.moved) {
          // remember where everything was, so the whole drag is one undo
          const before: Edit[] = [];
          for (const [id, s] of d.start) {
            before.push({ shape: id, field: "x", value: s.x }, { shape: id, field: "y", value: s.y });
            if (s.from) before.push({ shape: id, field: "from", value: s.from });
            if (s.to) before.push({ shape: id, field: "to", value: s.to });
          }
          hist.current.undo.push(before);
          hist.current.redo = [];
          d.moved = true;
        }
        const edits: Edit[] = [];
        for (const [id, s] of d.start) {
          edits.push({ shape: id, field: "x", value: s.x + dx }, { shape: id, field: "y", value: s.y + dy });
          // loose arrow ends travel with the selection; pinned ends follow their shapes anyway
          if (s.from && !s.from.shape) edits.push({ shape: id, field: "from", value: { x: s.from.x + dx, y: s.from.y + dy } });
          if (s.to && !s.to.shape) edits.push({ shape: id, field: "to", value: { x: s.to.x + dx, y: s.to.y + dy } });
        }
        commit(edits, true);
        break;
      }
      case "resize": {
        const b = d.start;
        let x1 = b.x;
        let y1 = b.y;
        let x2 = b.x + b.w;
        let y2 = b.y + b.h;
        const px = snap(w.x, !free);
        const py = snap(w.y, !free);
        if (d.corner === 0 || d.corner === 3) x1 = px;
        else x2 = px;
        if (d.corner === 0 || d.corner === 1) y1 = py;
        else y2 = py;
        const n = norm({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
        commit([
          { shape: d.id, field: "x", value: n.x },
          { shape: d.id, field: "y", value: n.y },
          { shape: d.id, field: "w", value: Math.max(8, n.w) },
          { shape: d.id, field: "h", value: Math.max(8, n.h) },
        ], true);
        break;
      }
      case "marquee": {
        d.x = w.x;
        d.y = w.y;
        const m = norm({ x: d.sx, y: d.sy, w: d.x - d.sx, h: d.y - d.sy });
        const { shapes: list, byId } = shapes();
        sel.current = list.filter((s) => overlaps(box(s, byId), m)).map((s) => s.id);
        break;
      }
      case "make": {
        if (d.type === "note" || d.type === "text") break;
        const px = snap(w.x, !free);
        const py = snap(w.y, !free);
        const n = norm({ x: d.sx, y: d.sy, w: px - d.sx, h: py - d.sy });
        commit([
          { shape: d.id, field: "x", value: n.x },
          { shape: d.id, field: "y", value: n.y },
          { shape: d.id, field: "w", value: n.w },
          { shape: d.id, field: "h", value: n.h },
        ], true);
        break;
      }
      case "pen":
        d.pts.push(w.x, w.y);
        break;
      case "arrow":
        d.x = w.x;
        d.y = w.y;
        break;
    }
    dirty.current = true;
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "marquee") onSelection(sel.current);
    if (d.kind === "make") {
      const s = shapes().byId.get(d.id);
      if (s && (s.type === "rect" || s.type === "ellipse") && s.w < 6 && s.h < 6) {
        // a click, not a drag: give it a sensible size
        commit([
          { shape: d.id, field: "w", value: 144 },
          { shape: d.id, field: "h", value: 96 },
        ], true);
      }
      if (d.type === "note" || d.type === "text") setEditing(d.id);
      setTool("select");
    }
    if (d.kind === "pen" && d.pts.length >= 4) {
      const pts = simplify(d.pts);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]);
        maxX = Math.max(maxX, pts[i]);
        minY = Math.min(minY, pts[i + 1]);
        maxY = Math.max(maxY, pts[i + 1]);
      }
      const rel = pts.map((v, i) => Math.round((v - (i % 2 ? minY : minX)) * 10) / 10);
      commit(create({ type: "pen", x: minX, y: minY, w: maxX - minX, h: maxY - minY, points: rel, color: latest.current.ink, z: topZ(shapes().shapes) }).edits);
    }
    if (d.kind === "arrow") {
      if (Math.hypot(d.x - d.from.x, d.y - d.from.y) > 8) {
        const on = topAt(d.x, d.y);
        const to: End = on && on.type !== "arrow" && on.id !== d.from.shape ? { shape: on.id, x: d.x, y: d.y } : { x: d.x, y: d.y };
        const { id, edits } = create({ type: "arrow", x: d.from.x, y: d.from.y, w: 0, h: 0, from: d.from, to, color: latest.current.ink, z: topZ(shapes().shapes) });
        commit(edits);
        select([id]);
      }
      setTool("select");
    }
    dirty.current = true;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (latest.current.view) return;
    const w = toWorld(e.clientX, e.clientY);
    const top = topAt(w.x, w.y);
    if (top && (top.type === "note" || top.type === "text" || top.type === "rect" || top.type === "ellipse")) {
      select([top.id]);
      setEditing(top.id);
    } else if (!top) {
      const { id, edits } = create({ type: "text", x: snap(w.x, true), y: snap(w.y, true), w: 220, h: 34, text: "", color: latest.current.ink, z: topZ(shapes().shapes) });
      commit(edits);
      select([id]);
      setEditing(id);
    }
  };

  /* wheel: pan, or zoom around the pointer with ctrl / pinch */
  useEffect(() => {
    const el = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = cam.current;
      if (e.ctrlKey || e.metaKey) {
        const before = toWorld(e.clientX, e.clientY);
        c.z = Math.min(5, Math.max(0.08, c.z * Math.exp(-e.deltaY * 0.0022)));
        const r = el.getBoundingClientRect();
        c.x = before.x - (e.clientX - r.left) / c.z;
        c.y = before.y - (e.clientY - r.top) / c.z;
      } else {
        c.x += e.deltaX / c.z;
        c.y += e.deltaY / c.z;
      }
      dirty.current = true;
      force((n) => n + 1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* keyboard */
  useEffect(() => {
    const keys: Record<string, Tool> = { v: "select", h: "hand", r: "rect", o: "ellipse", a: "arrow", p: "pen", t: "text", n: "note" };
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === " ") {
        space.current = true;
        e.preventDefault();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const from = e.shiftKey ? hist.current.redo : hist.current.undo;
        const to = e.shiftKey ? hist.current.undo : hist.current.redo;
        const batch = from.pop();
        if (batch && !latest.current.view) {
          to.push(inverse(doc, batch));
          doc.change(batch);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        const batch = hist.current.redo.pop();
        if (batch && !latest.current.view) {
          hist.current.undo.push(inverse(doc, batch));
          doc.change(batch);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        select(shapes().shapes.map((s) => s.id));
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.current.length) {
        commit(sel.current.map((id) => ({ shape: id, field: "deleted", value: true })));
        select([]);
        return;
      }
      if (e.key === "Escape") {
        select([]);
        setTool("select");
        return;
      }
      if (e.key.startsWith("Arrow") && sel.current.length) {
        e.preventDefault();
        const step = e.shiftKey ? 32 : 8;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const { byId } = shapes();
        commit(sel.current.flatMap((id) => {
          const s = byId.get(id);
          return s ? [{ shape: id, field: "x", value: s.x + dx }, { shape: id, field: "y", value: s.y + dy }] : [];
        }));
        return;
      }
      if (!mod && keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") space.current = false;
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  /* the text editor floats over the shape being written in */
  const editShape = editing ? shapes().byId.get(editing) : undefined;
  const editStyle = editShape ? (() => {
    const p = toScreen(editShape.x, editShape.y);
    const z = cam.current.z;
    const pad = editShape.type === "note" ? 16 : editShape.type === "text" ? 2 : 12;
    return {
      left: p.x + pad * z,
      top: p.y + pad * z,
      width: Math.max(40, (editShape.w - pad * 2) * z),
      height: Math.max(28, (editShape.h - pad * 2) * z),
      fontSize: (editShape.type === "text" ? 22 : 15) * z,
    };
  })() : null;

  return (
    <div className="board">
      <canvas
        ref={canvas}
        className="board-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => onCursor(null)}
        onDoubleClick={onDoubleClick}
        aria-label="Whiteboard. Tools: V select, R rectangle, O ellipse, A arrow, P pen, T text, N note, H hand."
        role="img"
      />
      {editShape && editStyle && (
        <textarea
          className={`board-edit is-${editShape.type}`}
          style={editStyle}
          autoFocus
          defaultValue={editShape.text ?? ""}
          aria-label="Text"
          onChange={(e) => commit([{ shape: editShape.id, field: "text", value: e.target.value }], true)}
          onBlur={(e) => {
            if (editShape.type === "text" && !e.target.value.trim()) commit([{ shape: editShape.id, field: "deleted", value: true }], true);
            setEditing(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
          }}
        />
      )}
    </div>
  );
}

/** The edits that would put these fields back the way they are now (or remove a shape that does not exist yet). */
function inverse(doc: Doc, edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  const created = new Set<string>();
  for (const e of edits) {
    if (doc.get(e.shape, "type") === undefined) {
      if (!created.has(e.shape)) {
        created.add(e.shape);
        out.push({ shape: e.shape, field: "deleted", value: true });
      }
      continue;
    }
    const prev = doc.get(e.shape, e.field);
    out.push({ shape: e.shape, field: e.field, value: prev === undefined ? (e.field === "deleted" ? false : null) : prev });
  }
  return out;
}

/* ── painting ──────────────────────────────────────────────────────────── */

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, byId: Map<string, Shape>, P: Record<string, string>, lw: number, editing: boolean) {
  const col = P[s.color] || P.ink;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 1.7;
  const b = norm(s);
  switch (s.type) {
    case "rect":
      ctx.globalAlpha = 0.07;
      roundRect(ctx, b.x, b.y, b.w, b.h, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      if (s.text && !editing) label(ctx, s.text, b, col, 15, true);
      break;
    case "ellipse":
      ctx.globalAlpha = 0.07;
      ctx.beginPath();
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      if (s.text && !editing) label(ctx, s.text, b, col, 15, true);
      break;
    case "note": {
      ctx.globalAlpha = 0.2;
      roundRect(ctx, b.x, b.y, b.w, b.h, 4);
      ctx.fill();
      ctx.globalAlpha = 0.55;
      // a folded corner
      ctx.beginPath();
      ctx.moveTo(b.x + b.w - 18, b.y + b.h);
      ctx.lineTo(b.x + b.w, b.y + b.h - 18);
      ctx.lineTo(b.x + b.w - 18, b.y + b.h - 18);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      if (!editing) label(ctx, s.text || "", { x: b.x + 16, y: b.y + 16, w: b.w - 32, h: b.h - 32 }, P.ink, 15, false);
      break;
    }
    case "text":
      if (!editing) label(ctx, s.text || "", { x: b.x + 2, y: b.y + 2, w: Math.max(b.w, 600), h: b.h }, col, 22, false, true);
      break;
    case "pen": {
      const p = s.points ?? [];
      if (p.length < 4) break;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(s.x + p[0], s.y + p[1]);
      for (let i = 2; i < p.length - 2; i += 2) {
        const mx = (p[i] + p[i + 2]) / 2;
        const my = (p[i + 1] + p[i + 3]) / 2;
        ctx.quadraticCurveTo(s.x + p[i], s.y + p[i + 1], s.x + mx, s.y + my);
      }
      ctx.lineTo(s.x + p[p.length - 2], s.y + p[p.length - 1]);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const [a, z] = arrowEnds(s, byId);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(z.x, z.y);
      ctx.stroke();
      const ang = Math.atan2(z.y - a.y, z.x - a.x);
      ctx.beginPath();
      ctx.moveTo(z.x, z.y);
      ctx.lineTo(z.x - 13 * Math.cos(ang - 0.42), z.y - 13 * Math.sin(ang - 0.42));
      ctx.lineTo(z.x - 13 * Math.cos(ang + 0.42), z.y - 13 * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
  void lw;
}

function label(ctx: CanvasRenderingContext2D, text: string, b: Box, col: string, size: number, centred: boolean, serif = false) {
  ctx.fillStyle = col;
  ctx.font = serif ? `italic 400 ${size}px Newsreader, Georgia, serif` : `400 ${size}px Newsreader, Georgia, serif`;
  const lines = wrap(text, b.w - (centred ? 16 : 0), (t) => ctx.measureText(t).width);
  const lh = size * 1.3;
  ctx.textBaseline = "top";
  ctx.textAlign = centred ? "center" : "left";
  const y0 = centred ? b.y + b.h / 2 - (lines.length * lh) / 2 : b.y;
  lines.forEach((l, i) => ctx.fillText(l, centred ? b.x + b.w / 2 : b.x, y0 + i * lh));
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** A starling in flight: two swept wings, the cursor's tip at the beak. */
function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, offline: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = offline ? 0.45 : 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(6, 4, 15, 3);
  ctx.quadraticCurveTo(9, 7, 7, 15);
  ctx.quadraticCurveTo(4, 7, 0, 0);
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
