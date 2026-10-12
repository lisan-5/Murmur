/** Routes by hash, so the app is a set of static files any host can serve:
 *   #/            the landing page
 *   #/b/<board>   a board
 *   anything else lost from the flock */
import { useEffect, useState } from "react";
import { BoardPage } from "./BoardPage";
import { Landing } from "../landing/Landing";
import { Mark, ThemeSwitch } from "./chrome";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function initialTheme(): string {
  try {
    const saved = localStorage.getItem("murmur.theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* fall through */
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const hash = useHash();
  const [theme, setTheme] = useState(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("murmur.theme", theme);
    } catch {
      /* fine */
    }
  }, [theme]);
  const onTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const board = /^#\/b\/([\w-]{1,64})$/.exec(hash)?.[1];
  if (board) return <BoardPage key={board} board={board} theme={theme} onTheme={onTheme} />;
  if (hash === "" || hash === "#" || hash === "#/") return <Landing theme={theme} onTheme={onTheme} />;
  return <Lost theme={theme} onTheme={onTheme} />;
}

function Lost({ theme, onTheme }: { theme: string; onTheme: () => void }) {
  return (
    <main className="lost">
      <header className="lost-top">
        <a href="#/" aria-label="Murmur home">
          <Mark />
        </a>
        <ThemeSwitch theme={theme} onTheme={onTheme} />
      </header>
      <svg className="lost-bird" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1 3 Q 7 7, 15 5 Q 9 9, 8 15 Q 5 8, 1 3 Z" />
      </svg>
      <h1>Lost from the flock.</h1>
      <p>There is no board at this address. It may have been a typo, or a bird that flew off on its own.</p>
      <a className="cta" href="#/">
        Back to the flock
      </a>
    </main>
  );
}
