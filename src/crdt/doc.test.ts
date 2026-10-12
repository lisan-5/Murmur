import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Doc, compare, replay, type Op } from "./doc";

const edit = (shape: string, field: string, value: unknown) => ({ shape, field, value });

describe("Doc basics", () => {
  it("applies local edits and reads them back", () => {
    const d = new Doc("a");
    d.change([edit("s1", "type", "rect"), edit("s1", "x", 10)]);
    expect(d.state()).toEqual({ s1: { id: "s1", type: "rect", x: 10 } });
    expect(d.version).toEqual({ a: 2 });
  });

  it("is idempotent: the same op twice changes nothing", () => {
    const a = new Doc("a");
    const ops = a.change([edit("s", "x", 1)]);
    const b = new Doc("b");
    expect(b.apply(ops)).toHaveLength(1);
    expect(b.apply(ops)).toHaveLength(0);
    expect(b.hash()).toBe(a.hash());
  });

  it("orders concurrent writes the same way everywhere (counter, then replica)", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    const oa = a.change([edit("s", "color", "red")]);
    const ob = b.change([edit("s", "color", "blue")]);
    a.apply(ob);
    b.apply(oa);
    // equal counters: the larger replica id wins, on both sides
    expect(a.get("s", "color")).toBe("blue");
    expect(b.get("s", "color")).toBe("blue");
  });

  it("a later write beats an earlier one, even from a smaller replica id", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    b.apply(a.change([edit("s", "x", 1)]));
    a.apply(b.change([edit("s", "x", 2)])); // b has seen a's write, so its clock is ahead
    const late = a.change([edit("s", "x", 3)]);
    b.apply(late);
    expect(a.get("s", "x")).toBe(3);
    expect(b.get("s", "x")).toBe(3);
  });

  it("hides deleted shapes", () => {
    const d = new Doc("a");
    d.change([edit("s", "type", "rect"), edit("s", "deleted", true)]);
    expect(d.state()).toEqual({});
  });

  it("finds exactly what the other side is missing", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    b.apply(a.change([edit("s", "x", 1), edit("s", "y", 2)]));
    a.change([edit("s", "z", 3)]);
    const gap = a.missing(b.version);
    expect(gap.map((o) => o.field)).toEqual(["z"]);
    expect(b.behind(a.version)).toBe(true);
    b.apply(gap);
    expect(b.behind(a.version)).toBe(false);
  });

  it("keeps its version vector contiguous when ops arrive with gaps", () => {
    const a = new Doc("a");
    const ops = a.change([edit("s", "x", 1), edit("s", "x", 2), edit("s", "x", 3)]);
    const b = new Doc("b");
    b.apply([ops[2]]);
    expect(b.version).toEqual({ a: 0 });
    expect(b.missing({}).length).toBe(1);
    b.apply([ops[0]]);
    expect(b.version).toEqual({ a: 1 });
    b.apply([ops[1]]);
    expect(b.version).toEqual({ a: 3 });
    expect(b.get("s", "x")).toBe(3);
  });

  it("continues its own numbering after restoring from storage", () => {
    const first = new Doc("a");
    const old = first.change([edit("s", "x", 1)]);
    const again = new Doc("a");
    again.apply(old);
    const next = again.change([edit("s", "x", 2)]);
    expect(next[0].seq).toBe(2);
    expect(compare(next[0].id, old[0].id)).toBeGreaterThan(0);
  });

  it("replays the log up to a moment", () => {
    const d = new Doc("a");
    d.change([edit("s", "type", "rect")], 100);
    d.change([edit("s", "x", 5)], 200);
    expect(replay(d.log(), 150).state()).toEqual({ s: { id: "s", type: "rect" } });
    expect(replay(d.log()).state()).toEqual(d.state());
  });
});

/* ── the proof: random edits, random delivery, every replica converges ─────── */

const field = fc.constantFrom("x", "y", "color", "text", "deleted");
const value = fc.oneof(fc.integer({ min: -50, max: 50 }), fc.constantFrom("red", "blue", "", "hi"), fc.boolean());
const action = fc.oneof(
  // a replica makes an edit
  fc.record({ kind: fc.constant("edit" as const), who: fc.nat(3), shape: fc.constantFrom("s1", "s2", "s3"), field, value }),
  // some ops travel from one replica to another: partial, possibly reordered, possibly duplicated
  fc.record({ kind: fc.constant("sync" as const), from: fc.nat(3), to: fc.nat(3), take: fc.nat(6), seed: fc.nat() }),
);

describe("convergence (property)", () => {
  it("any delivery order, any duplication, any partial sync: once everyone has everything, every board is identical", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 80 }), (actions) => {
        const docs = [0, 1, 2, 3].map((i) => new Doc(`r${i}`));
        for (const a of actions) {
          if (a.kind === "edit") {
            docs[a.who].change([edit(a.shape, a.field, a.value)]);
          } else if (a.from !== a.to) {
            const all = docs[a.from].log();
            // a shuffled, truncated, duplicated slice: what a bad network would deliver
            const pick: Op[] = [];
            for (let i = 0; i < a.take; i++) if (all.length) pick.push(all[(a.seed + i * 7) % all.length]);
            docs[a.to].apply(pick.reverse());
          }
        }
        // anti-entropy: everyone exchanges what the other is missing
        for (const x of docs) for (const y of docs) y.apply(x.missing(y.version));
        const h = docs[0].hash();
        for (const d of docs) {
          expect(d.hash()).toBe(h);
          expect(d.state()).toEqual(docs[0].state());
          expect(d.size).toBe(docs[0].size);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("the board depends only on the set of ops, never on their order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ who: fc.nat(2), shape: fc.constantFrom("a", "b"), field, value }), { minLength: 1, maxLength: 40 }),
        fc.nat(),
        (edits, seed) => {
          const writers = [0, 1, 2].map((i) => new Doc(`w${i}`));
          const all: Op[] = [];
          for (const e of edits) {
            // writers stay loosely in touch, so clocks interleave realistically
            const ops = writers[e.who].change([edit(e.shape, e.field, e.value)]);
            all.push(...ops);
            writers[(e.who + 1) % 3].apply(ops);
          }
          const forward = new Doc("f");
          forward.apply(all);
          const shuffled = [...all].sort((p, q) => ((p.seq * 31 + seed) % 97) - ((q.seq * 31 + seed) % 97));
          const backward = new Doc("b");
          backward.apply(shuffled);
          backward.apply(all); // and again, for idempotence
          expect(backward.state()).toEqual(forward.state());
        },
      ),
      { numRuns: 400 },
    );
  });
});
