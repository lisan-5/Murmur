/**
 * A live board. Wires the CRDT to the tabs around it (and the server, if one is configured),
 * stores everything offline, and frames the canvas with Murmur's instruments:
 *   the flock    who is here, and whether every copy of the board agrees
 *   the weather  wind, fog and storm between you and everyone else
 *   dusk         the board's whole history, to scrub back through
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Doc, replay, type Op } from "../crdt/doc";
import { Board, type Tool } from "../board/Board";
import { create, INKS, topZ, shapesOf, type Ink } from "../board/model";
import { Sync } from "../net/sync";
import { SocketWire, TabWire, Weather, type Conditions } from "../net/weather";
import { loadOps, saveOps } from "../net/store";
import type { Presence, Wire } from "../net/protocol";
import { identity } from "./identity";
import { Mark, ThemeSwitch } from "./chrome";

const SERVER = import.meta.env.VITE_MURMUR_SERVER as string | undefined;

type LogLine = { id: number; text: string; color: string; base?: string; n?: number };

export function BoardPage({ board, theme, onTheme }: { board: string; theme: string; onTheme: () => void }) {
  const me = useMemo(identity, []);
  const doc = useMemo(() => new Doc(me.replica), [me.replica]);
  const [sync, setSync] = useState<Sync | null>(null);
  const skies = useRef<Weather[]>([]);
  const [conditions, setConditions] = useState<Conditions>({ wind: 0, fog: 0, storm: false });
  const [peers, setPeers] = useState<Presence[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [ink, setInk] = useState<Ink>("ink");
  const [panel, setPanel] = useState<"weather" | null>(() => (innerWidth < 760 ? null : "weather"));
  const [dusk, setDusk] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const selection = useRef<string[]>([]);
  const logId = useRef(0);

  /* boot: restore from disk, then join the flock */
  useEffect(() => {
    let alive = true;
    let s: Sync | null = null;
    const offSave = doc.onChange((ops) => saveOps(board, ops));
    loadOps(board).then((ops) => {
      if (!alive) return;
      doc.apply(ops);
      setLoaded(true);
      const wires: Wire[] = [new TabWire(board)];
      let sock: SocketWire | null = null;
      if (SERVER) {
        sock = new SocketWire(`${SERVER.replace(/\/$/, "")}/?board=${encodeURIComponent(board)}`, () => s?.hello());
        wires.push(sock);
      }
      skies.current = wires.map((w) => new Weather(w));
      s = new Sync(doc, skies.current, 1500);
      s.onPresence(() => setPeers(s!.presence));
      s.onRemoteOps((ops, from) => {
        const who = s!.presence.find((p) => p.replica === from);
        const line: LogLine = { id: ++logId.current, text: describe(ops, who?.name ?? from), color: who?.color ?? "var(--ink-3)" };
        // a drag sends many small edits: fold repeats into one line with a count
        setLog((l) => (l[0] && l[0].base === line.text ? [{ ...l[0], n: (l[0].n ?? 1) + 1, id: line.id }, ...l.slice(1)] : [{ ...line, base: line.text, n: 1 }, ...l].slice(0, 7)));
      });
      setSync(s);
    });
    return () => {
      alive = false;
      offSave();
      s?.close();
    };
  }, [board, doc]);

  /* weather changes reach every wire; when a storm passes, ask what we missed straight away */
  useEffect(() => {
    const was = skies.current[0]?.conditions.storm;
    for (const w of skies.current) w.conditions = { ...conditions };
    if (was && !conditions.storm) sync?.hello();
  }, [conditions, sync]);

  /* tell the flock where we are, often */
  useEffect(() => {
    if (!sync) return;
    const say = () =>
      sync.announce({ ...me, cursor: cursor.current, selection: selection.current, hash: doc.hash(), ops: doc.size, offline: conditions.storm });
    say();
    const t = setInterval(() => {
      say();
      setTick((n) => n + 1);
    }, 700);
    return () => clearInterval(t);
  }, [sync, me, doc, conditions.storm]);

  const throttle = useRef(0);
  const onCursor = (pt: { x: number; y: number } | null) => {
    cursor.current = pt;
    const now = performance.now();
    if (sync && now - throttle.current > 45) {
      throttle.current = now;
      sync.announce({ ...me, cursor: pt, selection: selection.current, hash: doc.hash(), ops: doc.size, offline: conditions.storm });
    }
  };

  /* dusk: a replay of the board up to a moment */
  const history = useMemo(() => (dusk === null ? [] : doc.log().sort((a, b) => a.at - b.at)), [dusk === null, doc, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const span = history.length ? [history[0].at, history[history.length - 1].at] : [0, 0];
  const view = useMemo(() => (dusk === null ? null : replay(history, span[0] + (span[1] - span[0]) * dusk)), [dusk, history, span[0], span[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  /* does everyone agree? */
  const flock = [{ ...me, hash: doc.hash(), ops: doc.size, offline: conditions.storm, cursor: null, selection: [] } as Presence, ...peers];
  const states = new Set(flock.map((p) => p.hash)).size;

  const stats = skies.current.reduce(
    (a, w) => ({ out: a.out + w.stats.out, in: a.in + w.stats.in, lost: a.lost + w.stats.lost, held: a.held + w.stats.held, inFlight: a.inFlight + w.stats.inFlight }),
    { out: 0, in: 0, lost: 0, held: 0, inFlight: 0 },
  );

  const seed = (n: number) => {
    const shapes = shapesOf(doc.state());
    let z = topZ(shapes);
    const edits = [];
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const kind = (["rect", "ellipse", "note"] as const)[i % 3];
      edits.push(...create({ type: kind, x: 2000 + (i % cols) * 70, y: (Math.floor(i / cols)) * 70, w: 56, h: 56, text: kind === "note" ? "" : undefined, color: INKS[i % INKS.length], z: (z += 0.001) }).edits);
    }
    doc.change(edits);
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* the address bar has it */
    }
  };

  return (
    <div className={`app ${conditions.storm ? "is-storm" : ""}`} style={{ "--fog": conditions.fog, "--wind": Math.min(1, conditions.wind / 1500) } as React.CSSProperties}>
      <Board
        doc={doc}
        view={view}
        tool={tool}
        setTool={setTool}
        ink={ink}
        peers={peers}
        me={me}
        onCursor={onCursor}
        onSelection={(ids) => (selection.current = ids)}
        themeKey={theme}
      />
      <div className="sky-weather" aria-hidden="true" />

      <header className="topbar">
        <a href="#/" className="home" aria-label="Murmur home">
          <Mark size={30} />
        </a>
        <span className="board-name" title="This board">
          {board}
        </span>
        <button className="chip" onClick={share}>
          {copied ? "Link copied" : "Invite"}
        </button>
        <button className="chip" onClick={() => window.open(location.href, "_blank", "popup,width=900,height=700")}>
          Open a second window
        </button>
        <span className="spacer" />
        <div className="flock" aria-label="Who is here">
          {flock.map((p) => (
            <span key={p.replica} className={`bird ${p.offline || p.quiet ? "is-off" : ""}`} style={{ "--c": p.color } as React.CSSProperties} title={`${p.name}${p.replica === me.replica ? " (you)" : ""}${p.offline ? ", in a storm" : p.quiet ? ", not heard from lately" : ""}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M1 3 Q 7 7, 15 5 Q 9 9, 8 15 Q 5 8, 1 3 Z" />
              </svg>
              <span>{p.replica === me.replica ? "you" : p.name}</span>
            </span>
          ))}
        </div>
        <span className={`agree ${states > 1 ? "is-drift" : ""}`} role="status" aria-live="polite">
          {flock.length} {flock.length === 1 ? "copy" : "copies"} · {states === 1 ? "one board" : `${states} versions, ${flock.some((p) => p.offline || p.quiet) ? "drifting" : "converging"}`}
        </span>
        <ThemeSwitch theme={theme} onTheme={onTheme} />
      </header>

      <nav className="tools" aria-label="Tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? "is-on" : ""} onClick={() => setTool(t.id)} aria-label={`${t.label} (${t.key})`} title={`${t.label}  ${t.key}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={t.icon} />
            </svg>
          </button>
        ))}
        <span className="sep" />
        {INKS.map((c) => (
          <button key={c} className={`ink ${ink === c ? "is-on" : ""}`} onClick={() => setInk(c)} aria-label={`${c} ink`} style={{ "--c": `var(--${c})` } as React.CSSProperties}>
            <i />
          </button>
        ))}
      </nav>

      <aside className={`weather ${panel ? "is-open" : ""}`} aria-label="Weather">
        <button className="weather-tab" onClick={() => setPanel(panel ? null : "weather")} aria-expanded={!!panel}>
          Weather
        </button>
        {panel && (
          <div className="weather-body">
            <p className="w-intro">The sky between you and the rest of the flock. Make it bad and watch the board hold.</p>
            <label className="w-row">
              <span>
                Wind <em>{conditions.wind} ms lag</em>
              </span>
              <input type="range" min={0} max={2000} step={50} value={conditions.wind} onChange={(e) => setConditions((c) => ({ ...c, wind: +e.target.value }))} />
            </label>
            <label className="w-row">
              <span>
                Fog <em>{Math.round(conditions.fog * 100)}% lost</em>
              </span>
              <input type="range" min={0} max={0.8} step={0.05} value={conditions.fog} onChange={(e) => setConditions((c) => ({ ...c, fog: +e.target.value }))} />
            </label>
            <button className={`storm ${conditions.storm ? "is-on" : ""}`} onClick={() => setConditions((c) => ({ ...c, storm: !c.storm }))} aria-pressed={conditions.storm}>
              {conditions.storm ? "Let the storm pass" : "Call a storm (go offline)"}
            </button>
            <dl className="readout">
              <div><dt>sent</dt><dd>{stats.out}</dd></div>
              <div><dt>heard</dt><dd>{stats.in}</dd></div>
              <div><dt>lost</dt><dd>{stats.lost}</dd></div>
              <div><dt>held back</dt><dd>{stats.held}</dd></div>
              <div><dt>in flight</dt><dd>{stats.inFlight}</dd></div>
              <div><dt>edits held</dt><dd>{doc.size}</dd></div>
            </dl>
            <p className="w-hash">
              board <code>{doc.hash()}</code>
            </p>
            <ol className="w-log" aria-label="Edits arriving">
              {log.map((l) => (
                <li key={l.id} style={{ "--c": l.color } as React.CSSProperties}>
                  {l.text}
                  {(l.n ?? 1) > 1 && <b className="w-n"> ×{l.n}</b>}
                </li>
              ))}
              {!log.length && <li className="quiet">Edits from the flock land here.</li>}
            </ol>
            <button className="chip ghost" onClick={() => seed(1000)}>
              Release 1,000 shapes
            </button>
          </div>
        )}
      </aside>

      <footer className={`dusk ${dusk !== null ? "is-on" : ""}`}>
        <button className="chip" onClick={() => setDusk(dusk === null ? 1 : null)} aria-pressed={dusk !== null}>
          {dusk === null ? "Dusk: replay the board" : "Back to now"}
        </button>
        {dusk !== null && (
          <label className="dusk-track">
            <span className="sr-only">Replay position</span>
            <input type="range" min={0} max={1} step={0.001} value={dusk} onChange={(e) => setDusk(+e.target.value)} />
            <span className="dusk-time">
              {history.length ? new Date(span[0] + (span[1] - span[0]) * dusk).toLocaleTimeString() : "nothing yet"} · {view?.size ?? 0} of {history.length} edits
            </span>
          </label>
        )}
      </footer>

      {!loaded && <div className="loading">Gathering the flock</div>}
    </div>
  );
}

function describe(ops: Op[], who: string): string {
  const shapes = new Set(ops.map((o) => o.shape)).size;
  const kinds = new Set(ops.map((o) => o.field));
  const what = kinds.has("type") ? "drew" : kinds.has("deleted") ? "removed" : kinds.has("text") ? "wrote in" : kinds.has("x") ? "moved" : "changed";
  return `${who} ${what} ${shapes} shape${shapes === 1 ? "" : "s"}`;
}

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "select", label: "Select", key: "V", icon: "M5 3 L19 12 L12 13.5 L9 20 Z" },
  { id: "hand", label: "Pan", key: "H / Space", icon: "M8 12 V6 a1.5 1.5 0 0 1 3 0 V11 V4.5 a1.5 1.5 0 0 1 3 0 V11 V6 a1.5 1.5 0 0 1 3 0 V14 a6 6 0 0 1 -6 6 h-1 a6 6 0 0 1 -5 -3 L4 13 a1.5 1.5 0 0 1 2.4 -1.8 Z" },
  { id: "rect", label: "Rectangle", key: "R", icon: "M4 6 H20 V18 H4 Z" },
  { id: "ellipse", label: "Ellipse", key: "O", icon: "M12 5 C 18 5, 21 8.5, 21 12 C 21 15.5, 18 19, 12 19 C 6 19, 3 15.5, 3 12 C 3 8.5, 6 5, 12 5 Z" },
  { id: "arrow", label: "Arrow", key: "A", icon: "M4 18 L19 5 M11 5 H19 V13" },
  { id: "pen", label: "Pen", key: "P", icon: "M4 17 C 7 11, 10 19, 13 12 S 18 8, 20 6" },
  { id: "text", label: "Text", key: "T", icon: "M5 6 H19 M12 6 V19 M9 19 H15" },
  { id: "note", label: "Note", key: "N", icon: "M5 4 H19 V14 L13 20 H5 Z M13 20 V14 H19" },
];
