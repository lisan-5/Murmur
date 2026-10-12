/**
 * Numbers for the README, measured, not guessed:
 *   how fast the engine applies ops, how big a 10,000 shape board is,
 *   and how many random histories converge (all of them, or the build should fail).
 *   npm run bench
 */
import { Doc, type Op } from "../src/crdt/doc";

const t = () => performance.now();

// 1. a 10,000 shape board: 10 fields each
{
  const d = new Doc("bench");
  const t0 = t();
  for (let i = 0; i < 10_000; i++) {
    d.change(["type", "x", "y", "w", "h", "color", "z", "text", "from", "to"].map((f) => ({ shape: `s${i}`, field: f, value: f === "type" ? "rect" : i })));
  }
  const made = t() - t0;
  const log = d.log();
  const t1 = t();
  const other = new Doc("other");
  other.apply(log);
  const merged = t() - t1;
  const bytes = JSON.stringify(log).length;
  console.log(`10,000 shapes = ${log.length.toLocaleString()} ops, ${(bytes / 1e6).toFixed(1)} MB as JSON`);
  console.log(`  written locally in ${made.toFixed(0)} ms, merged into an empty replica in ${merged.toFixed(0)} ms (${Math.round(log.length / (merged / 1000)).toLocaleString()} ops/s)`);
  console.log(`  same board on both: ${d.hash() === other.hash()}`);
}

// 2. random histories: five replicas, random edits, random partial deliveries
{
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const runs = 2000;
  let agreed = 0;
  let ops = 0;
  const t0 = t();
  for (let run = 0; run < runs; run++) {
    const docs = Array.from({ length: 5 }, (_, i) => new Doc(`r${i}`));
    for (let k = 0; k < 120; k++) {
      const who = docs[Math.floor(rnd() * 5)];
      if (rnd() < 0.6) who.change([{ shape: `s${Math.floor(rnd() * 8)}`, field: ["x", "y", "color", "text", "deleted"][Math.floor(rnd() * 5)], value: Math.floor(rnd() * 100) }]);
      else {
        const to = docs[Math.floor(rnd() * 5)];
        const all: Op[] = who.log();
        to.apply(all.filter(() => rnd() < 0.4).reverse());
      }
    }
    for (const a of docs) for (const b of docs) b.apply(a.missing(b.version));
    ops += docs[0].size;
    if (new Set(docs.map((d) => d.hash())).size === 1) agreed++;
  }
  console.log(`${runs.toLocaleString()} random histories (5 replicas, lossy reordered delivery, ${ops.toLocaleString()} ops): ${agreed.toLocaleString()} converged, in ${(t() - t0).toFixed(0)} ms`);
  if (agreed !== runs) process.exit(1);
}
