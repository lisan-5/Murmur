/**
 * A murmuration: boids (separation, alignment, cohesion) on a 2D canvas, steered toward
 * "scenes" that tell Murmur's story as you scroll:
 *   word   the flock spells the name
 *   three  it splits into three flocks: three copies of a board, each its own
 *   storm  one of them is scattered by weather
 *   one    they wheel together into a single flock again
 * The pointer is a hawk: birds near it break away. A spatial grid keeps it fast.
 */

export type Scene = "word" | "three" | "storm" | "one" | "free";

type Bird = { x: number; y: number; vx: number; vy: number; tx: number; ty: number; g: number };

export type Flock = {
  scene: (s: Scene, anchor?: number) => void;
  startle: () => void;
  stop: () => void;
  readonly count: number;
};

export function startFlock(canvas: HTMLCanvasElement, opts: { word: string; reduced: boolean }): Flock {
  const ctx = canvas.getContext("2d")!;
  let W = 0;
  let H = 0;
  let dpr = 1;
  const small = innerWidth < 700;
  const N = small ? 650 : 1500;
  const birds: Bird[] = [];
  let scene: Scene = "word";
  /** where the flock gathers across the screen, 0..1, so it keeps clear of the text */
  let anchor = 0.5;
  let wordPts: { x: number; y: number }[] = [];
  let hawk = { x: -9999, y: -9999 };
  let ink = "#16181f";
  let accent = "#e2562a";
  let running = true;
  let visible = true;
  let raf = 0;
  let t = 0;

  const colours = () => {
    const cs = getComputedStyle(document.documentElement);
    ink = cs.getPropertyValue("--ink").trim() || ink;
    accent = cs.getPropertyValue("--accent").trim() || accent;
  };

  /* sample the word into points the birds can settle on */
  const sampleWord = () => {
    const off = document.createElement("canvas");
    // narrow screens: the word breaks into two lines, mur / mur, so the birds can still spell it
    const lines = W < 700 ? [opts.word.slice(0, 3), opts.word.slice(3)] : [opts.word];
    const fw = Math.min(W * 0.86, 1300);
    const size = Math.min(fw / (lines.length > 1 ? 1.6 : 3.1), (H * 0.42) / lines.length);
    off.width = Math.ceil(fw);
    off.height = Math.ceil(size * 1.15 * lines.length + size * 0.2);
    const o = off.getContext("2d")!;
    o.fillStyle = "#000";
    o.font = `italic 500 ${size}px Newsreader, Georgia, serif`;
    o.textAlign = "center";
    o.textBaseline = "middle";
    lines.forEach((l, i) => o.fillText(l, off.width / 2, off.height / 2 + (i - (lines.length - 1) / 2) * size * 1.0));
    const data = o.getImageData(0, 0, off.width, off.height).data;
    const pts: { x: number; y: number }[] = [];
    const step = Math.max(3, Math.round(size / 46));
    for (let y = 0; y < off.height; y += step)
      for (let x = 0; x < off.width; x += step) if (data[(y * off.width + x) * 4 + 3] > 128) pts.push({ x: x + (W - off.width) / 2, y: y + H * 0.44 - off.height / 2 });
    // shuffle, so neighbouring birds do not take neighbouring letters
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pts[i], pts[j]] = [pts[j], pts[i]];
    }
    wordPts = pts;
  };

  const size = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    sampleWord();
    assign();
  };

  /* each bird gets a place in the current scene */
  const assign = () => {
    const cy = H / 2;
    birds.forEach((b, i) => {
      b.g = i % 3;
      if (scene === "word" && wordPts.length) {
        const p = wordPts[i % wordPts.length];
        b.tx = p.x;
        b.ty = p.y;
      } else if (scene === "three" || scene === "storm") {
        const gx = W * (anchor + (b.g - 1) * (small ? 0.24 : 0.17));
        const a = (i * 2.399) % (Math.PI * 2);
        const r = Math.sqrt((i % 500) / 500) * Math.min(W, H) * 0.13;
        b.tx = gx + Math.cos(a) * r * 1.3;
        b.ty = cy + Math.sin(a) * r;
      } else if (scene === "one") {
        const a = (i * 2.399) % (Math.PI * 2);
        const r = Math.sqrt(i / N) * Math.min(W, H) * (small ? 0.3 : 0.24);
        b.tx = W * anchor + Math.cos(a) * r * 1.6;
        b.ty = cy + Math.sin(a) * r * 0.8;
      } else {
        b.tx = NaN;
        b.ty = NaN;
      }
    });
  };

  for (let i = 0; i < N; i++) {
    birds.push({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, vx: Math.random() * 2 - 1, vy: Math.random() * 2 - 1, tx: NaN, ty: NaN, g: i % 3 });
  }
  colours();
  size();

  /* a grid of cells, so each bird only looks at its neighbours */
  const CELL = 36;
  let grid = new Map<number, Bird[]>();
  const key = (x: number, y: number) => Math.floor(x / CELL) * 10007 + Math.floor(y / CELL);

  const step = () => {
    t += 1;
    grid = new Map();
    for (const b of birds) {
      const k = key(b.x, b.y);
      const cell = grid.get(k);
      if (cell) cell.push(b);
      else grid.set(k, [b]);
    }
    const storming = scene === "storm";
    for (const b of birds) {
      let sx = 0;
      let sy = 0;
      let ax = 0;
      let ay = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      const gx = Math.floor(b.x / CELL);
      const gy = Math.floor(b.y / CELL);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          const cell = grid.get((gx + i) * 10007 + (gy + j));
          if (!cell) continue;
          for (const o of cell) {
            if (o === b) continue;
            const dx = b.x - o.x;
            const dy = b.y - o.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > CELL * CELL) continue;
            n++;
            ax += o.vx;
            ay += o.vy;
            cx += o.x;
            cy += o.y;
            if (d2 < 90) {
              sx += dx / (d2 + 0.1);
              sy += dy / (d2 + 0.1);
            }
          }
        }
      if (n) {
        b.vx += (ax / n - b.vx) * 0.04 + (cx / n - b.x) * 0.0008 + sx * 0.9;
        b.vy += (ay / n - b.vy) * 0.04 + (cy / n - b.y) * 0.0008 + sy * 0.9;
      }
      // the scene pulls each bird toward its place, gently, so the shape breathes
      if (!Number.isNaN(b.tx)) {
        let tx = b.tx;
        let ty = b.ty;
        if (storming && b.g === 2) {
          tx += Math.sin(t * 0.05 + b.ty) * 120;
          ty += Math.cos(t * 0.043 + b.tx) * 160;
        }
        const pull = scene === "word" ? 0.0065 : 0.003;
        b.vx += (tx - b.x) * pull;
        b.vy += (ty - b.y) * pull;
      } else {
        b.vx += Math.sin(t * 0.01 + b.y * 0.01) * 0.05;
        b.vy += Math.cos(t * 0.012 + b.x * 0.01) * 0.05;
      }
      // the hawk
      const hx = b.x - hawk.x;
      const hy = b.y - hawk.y;
      const h2 = hx * hx + hy * hy;
      if (h2 < 140 * 140) {
        const f = (1 - Math.sqrt(h2) / 140) * 1.6;
        b.vx += (hx / (Math.sqrt(h2) + 1)) * f;
        b.vy += (hy / (Math.sqrt(h2) + 1)) * f;
      }
      // speed limits and a little drag
      const sp = Math.hypot(b.vx, b.vy);
      const max = storming && b.g === 2 ? 7 : 4.2;
      if (sp > max) {
        b.vx = (b.vx / sp) * max;
        b.vy = (b.vy / sp) * max;
      }
      b.vx *= 0.965;
      b.vy *= 0.965;
      b.x += b.vx;
      b.y += b.vy;
      // wrap at the edges in free flight, soft walls otherwise
      if (b.x < -20) b.x = W + 20;
      if (b.x > W + 20) b.x = -20;
      if (b.y < -20) b.y = H + 20;
      if (b.y > H + 20) b.y = -20;
    }
  };

  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    // two passes: most birds in ink, the storm-struck third in the accent
    for (const pass of [0, 1]) {
      ctx.beginPath();
      ctx.strokeStyle = pass ? accent : ink;
      ctx.lineWidth = small ? 1.6 : 1.8;
      for (const b of birds) {
        const hot = scene === "storm" && b.g === 2;
        if (hot !== (pass === 1)) continue;
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const len = 2.2 + sp * 0.7;
        ctx.moveTo(b.x - (b.vx / sp) * len, b.y - (b.vy / sp) * len);
        ctx.lineTo(b.x + (b.vx / sp) * len * 0.4, b.y + (b.vy / sp) * len * 0.4);
      }
      ctx.stroke();
    }
  };

  const loop = () => {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (!visible || document.hidden) return;
    step();
    draw();
  };

  if (opts.reduced) {
    // place the word and hold still
    for (let i = 0; i < 260; i++) step();
    draw();
  } else raf = requestAnimationFrame(loop);

  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    hawk = { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onLeave = () => (hawk = { x: -9999, y: -9999 });
  addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerleave", onLeave);
  let resizeT = 0;
  const onResize = () => {
    clearTimeout(resizeT);
    resizeT = window.setTimeout(size, 150);
  };
  addEventListener("resize", onResize);
  const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
  io.observe(canvas);
  const mo = new MutationObserver(colours);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.fonts?.ready.then(() => {
    sampleWord();
    assign();
  });

  return {
    count: N,
    scene(s, at = 0.5) {
      if (s === scene && at === anchor) return;
      scene = s;
      anchor = at;
      assign();
      if (opts.reduced) {
        for (let i = 0; i < 260; i++) step();
        draw();
      }
    },
    startle() {
      for (const b of birds) {
        const a = Math.random() * Math.PI * 2;
        b.vx += Math.cos(a) * 9;
        b.vy += Math.sin(a) * 9;
      }
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      removeEventListener("resize", onResize);
      io.disconnect();
      mo.disconnect();
    },
  };
}
