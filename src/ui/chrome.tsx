/** Pieces shared by every page: the wordmark and the dusk / day switch. */

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <span className="mark" style={{ fontSize: size }}>
      <svg viewBox="0 0 16 16" aria-hidden="true" className="mark-bird">
        <path d="M1 3 Q 7 7, 15 5 Q 9 9, 8 15 Q 5 8, 1 3 Z" />
      </svg>
      murmur
    </span>
  );
}

export function ThemeSwitch({ theme, onTheme }: { theme: string; onTheme: () => void }) {
  const dark = theme === "dark";
  return (
    <button className="theme-switch" onClick={onTheme} aria-label={dark ? "Switch to day" : "Switch to dusk"} title={dark ? "Day" : "Dusk"}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {/* a sun on the horizon: risen for day, half set for dusk */}
        <path d="M2 16 H22" />
        <circle cx="12" cy={dark ? 18 : 13} r="5" />
      </svg>
    </button>
  );
}
