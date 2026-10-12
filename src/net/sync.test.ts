/**
 * End to end over a simulated network: several replicas, each behind its own weather,
 * editing while lagged, lossy and partitioned. When the weather clears, they must agree.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc } from "../crdt/doc";
import type { Msg, Wire } from "./protocol";
import { Sync } from "./sync";
import { Weather } from "./weather";

/** A shared medium: everything sent is heard by everyone else (like BroadcastChannel). */
function air() {
  const ears = new Set<(m: Msg) => void>();
  return (): Wire => {
    let mine: (m: Msg) => void = () => {};
    return {
      send: (m) => ears.forEach((e) => e !== mine && e(structuredClone(m))),
      onMessage: (fn) => {
        mine = fn;
        ears.add(fn);
      },
      close: () => ears.delete(mine),
    };
  };
}

/** a seeded random, so failures are reproducible */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

afterEach(() => vi.useRealTimers());

describe("sync over a bad network", () => {
  it("converges after wind, fog and a storm", async () => {
    vi.useFakeTimers();
    const join = air();
    const flock = [0, 1, 2].map((i) => {
      const doc = new Doc(`p${i}`);
      const sky = new Weather(join(), rng(i + 7));
      const sync = new Sync(doc, [sky], 500);
      return { doc, sky, sync };
    });

    // rough weather: lag everywhere, a third of messages lost, one bird cut off
    flock.forEach((b) => (b.sky.conditions = { wind: 120, fog: 0.33, storm: false }));
    flock[2].sky.conditions.storm = true;

    for (let step = 0; step < 60; step++) {
      const b = flock[step % 3];
      b.doc.change([{ shape: `s${step % 5}`, field: step % 2 ? "x" : "color", value: step }]);
      await vi.advanceTimersByTimeAsync(37);
    }
    // the storm bird has drifted
    expect(flock[2].doc.hash()).not.toBe(flock[0].doc.hash());

    // the weather clears; anti-entropy does the rest
    flock.forEach((b) => (b.sky.conditions = { wind: 0, fog: 0, storm: false }));
    await vi.advanceTimersByTimeAsync(3000);

    const h = flock[0].doc.hash();
    for (const b of flock) expect(b.doc.hash()).toBe(h);
    expect(flock[0].doc.size).toBe(60);
    // the fog really did eat messages, and they were recovered
    expect(flock.reduce((n, b) => n + b.sky.stats.lost, 0)).toBeGreaterThan(0);
    flock.forEach((b) => b.sync.close());
  });

  it("shares presence, and forgets a peer that says goodbye", async () => {
    vi.useFakeTimers();
    const join = air();
    const a = new Sync(new Doc("a"), [join()], 500);
    const b = new Sync(new Doc("b"), [join()], 500);
    b.announce({ replica: "b", name: "Ana", color: "#f80", cursor: { x: 1, y: 2 }, selection: [], hash: "0", ops: 0, offline: false });
    expect(a.presence.map((p) => p.name)).toEqual(["Ana"]);
    expect(a.presence[0].quiet).toBe(false);
    // a peer that goes silent is kept, marked quiet
    await vi.advanceTimersByTimeAsync(6000);
    expect(a.presence[0].quiet).toBe(true);
    b.close();
    expect(a.presence).toEqual([]);
    a.close();
  });
});
