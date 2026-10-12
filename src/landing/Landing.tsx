/**
 * The landing page is a murmuration at dusk, and the story of how Murmur stays in one piece
 * is told by the flock itself as you scroll: it spells the name, splits into three copies,
 * one is scattered by a storm, then they wheel back into one.
 */
import { useEffect, useRef, useState } from "react";
import { startFlock, type Flock, type Scene } from "./flock";
import { Mark, ThemeSwitch } from "../ui/chrome";
import { newBoardId } from "../ui/identity";

const CHAPTERS: { scene: Scene; kicker: string; title: string; body: string }[] = [
  {
    scene: "three",
    kicker: "No leader",
    title: "Every window keeps its own copy.",
    body: "Each person draws on their own copy of the board, instantly. Edits fly to everyone else. There is no server deciding who wins.",
  },
  {
    scene: "storm",
    kicker: "Weather",
    title: "Lag, lost messages, a laptop shut on a train.",
    body: "Murmur keeps drawing through all of it. Edits made in a storm wait, then find their way home.",
  },
  {
    scene: "one",
    kicker: "One flock",
    title: "And then they are one again.",
    body: "Any two copies that have seen the same edits show exactly the same board, whatever order the edits arrived in. The sync engine is written by hand and the tests prove it: hundreds of random histories, every one converging.",
  },
];

export function Landing({ theme, onTheme }: { theme: string; onTheme: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const flock = useRef<Flock | null>(null);
  const [scene, setScene] = useState<Scene>("word");
  const [count, setCount] = useState(0);

  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const f = startFlock(canvas.current!, { word: "murmur", reduced });
    flock.current = f;
    setCount(f.count);
    // S startles the flock, like a clap
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "s" && !(e.target as HTMLElement).closest("input, textarea")) f.startle();
    };
    addEventListener("keydown", key);
    return () => {
      f.stop();
      removeEventListener("keydown", key);
    };
  }, []);

  /* each chapter, as it reaches the middle of the screen, sets the flock's scene */
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>("[data-scene]");
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const s = e.target.getAttribute("data-scene") as Scene;
          // the flock gathers on the side of the screen the words are not on
          const side = e.target.classList.contains("is-left") ? 0.7 : e.target.classList.contains("is-right") ? 0.3 : 0.5;
          setScene(s);
          flock.current?.scene(s, innerWidth < 760 ? 0.5 : side);
        }),
      { rootMargin: "-45% 0px -45% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const start = () => {
    location.hash = `#/b/${newBoardId()}`;
  };

  return (
    <div className="landing">
      <canvas ref={canvas} className="sky" aria-hidden="true" />
      <header className="l-top">
        <Mark size={30} />
        <span className="l-live" aria-hidden="true">
          {count.toLocaleString()} birds · 0 leaders · {LABEL[scene]}
        </span>
        <ThemeSwitch theme={theme} onTheme={onTheme} />
      </header>

      <main>
        <section className="l-hero" data-scene="word">
          <h1 className="sr-only">Murmur</h1>
          <div className="l-hero-foot">
            <p className="l-lede">
              A whiteboard for many hands that never falls apart. <em>Draw together, offline or online, through any weather.</em>
            </p>
            <div className="l-acts">
              <button className="cta" onClick={start}>
                Start a board
              </button>
              <a className="cta ghost" href="#how">
                How it holds together
              </a>
            </div>
          </div>
          <p className="l-hint" aria-hidden="true">
            Your pointer is a hawk. Press S to startle them.
          </p>
        </section>

        <div id="how">
          {CHAPTERS.map((c, i) => (
            <section key={c.scene} className={`l-chapter is-${i % 2 ? "right" : "left"}`} data-scene={c.scene}>
              <div className="l-card">
                <p className="l-kicker">
                  <span>{String(i + 1).padStart(2, "0")}</span> {c.kicker}
                </p>
                <h2>{c.title}</h2>
                <p>{c.body}</p>
              </div>
            </section>
          ))}
        </div>

        <section className="l-try" data-scene="free">
          <h2>
            See it hold. <em>Break it, if you can.</em>
          </h2>
          <ol className="l-steps">
            <li>Start a board, then open a second window.</li>
            <li>In one, open the weather and call a storm.</li>
            <li>Draw in both. They drift apart.</li>
            <li>Let the storm pass. Watch them become one board.</li>
          </ol>
          <button className="cta" onClick={start}>
            Start a board
          </button>
        </section>
      </main>

      <footer className="l-foot">
        <span>Murmur · a CRDT whiteboard, sync engine written by hand</span>
        <a href="https://github.com/lisan-5/Murmur">Source on GitHub</a>
      </footer>
    </div>
  );
}

const LABEL: Record<Scene, string> = { word: "gathering", three: "three copies", storm: "one in a storm", one: "one flock", free: "free flight" };
