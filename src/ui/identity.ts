/** Who this tab is. Each tab is its own replica (and its own bird), so two windows make a flock of two. */

const BIRDS = ["Starling", "Swift", "Wren", "Finch", "Lark", "Linnet", "Martin", "Pipit", "Siskin", "Dunnock", "Twite", "Redpoll", "Chiffchaff", "Bunting"];
const COLORS = ["#ff8a4c", "#7cc4a8", "#b9a2ff", "#f2c14e", "#6fb1ff", "#ff7aa2", "#9fd36b"];

function once(key: string, make: () => string): string {
  try {
    const v = sessionStorage.getItem(key);
    if (v) return v;
    const n = make();
    sessionStorage.setItem(key, n);
    return n;
  } catch {
    return make();
  }
}

export function identity() {
  const replica = once("murmur.replica", () => Math.random().toString(36).slice(2, 8));
  const name = once("murmur.name", () => BIRDS[Math.floor(Math.random() * BIRDS.length)]);
  let h = 0;
  for (const c of replica) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { replica, name, color: COLORS[h % COLORS.length] };
}

export function newBoardId(): string {
  const words = ["dusk", "reed", "marsh", "ember", "alder", "fen", "loch", "heath", "tern", "sloe"];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.random().toString(36).slice(2, 7)}`;
}
