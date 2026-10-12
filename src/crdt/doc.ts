/**
 * Murmur's sync engine: a state-based-in-spirit, op-based CRDT, written by hand.
 *
 * A board is a map of shapes; every field of every shape is a last-writer-wins register.
 * Every edit is an Op stamped with a Lamport clock (counter, replica). Two stamps always
 * compare one way, so any replica that has seen the same set of ops computes the same
 * board, whatever order the ops arrived in, however many times each arrived.
 *
 *   apply is commutative   a then b == b then a
 *   apply is idempotent    a then a == a
 *   apply is associative   (a b) c == a (b c)
 *
 * Each replica numbers its own ops 1, 2, 3, ... (seq). A version vector (the highest
 * contiguous seq seen from each replica) says exactly which ops a replica has, so two
 * replicas can find what the other is missing without sending the whole log.
 */

export type ReplicaId = string;

/** Lamport stamp. Compared by counter, then replica id, so every pair of stamps is ordered. */
export type Stamp = { c: number; r: ReplicaId };

export type Op = {
  /** when, in Lamport time; also the identity of this write */
  id: Stamp;
  /** this op's number among its replica's ops, from 1 */
  seq: number;
  shape: string;
  field: string;
  value: unknown;
  /** wall clock at creation, used only by the timeline, never for ordering */
  at: number;
};

/** For each replica, the highest seq such that every op 1..seq from it is held. */
export type VersionVector = Record<ReplicaId, number>;

type Register = { value: unknown; id: Stamp };

export function compare(a: Stamp, b: Stamp): number {
  if (a.c !== b.c) return a.c - b.c;
  return a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
}

export class Doc {
  readonly replica: ReplicaId;
  private clock = 0;
  private nextSeq = 1;
  /** every op held, by replica, by seq */
  private ops = new Map<ReplicaId, Map<number, Op>>();
  private vv: VersionVector = {};
  /** shape -> field -> winning register */
  private regs = new Map<string, Map<string, Register>>();
  private listeners = new Set<(ops: Op[]) => void>();

  constructor(replica: ReplicaId) {
    this.replica = replica;
  }

  /* ── writing ─────────────────────────────────────────────────────────── */

  /** Make local edits. Returns the new ops, already applied, ready to send. */
  change(edits: { shape: string; field: string; value: unknown }[], at = Date.now()): Op[] {
    const out: Op[] = [];
    for (const e of edits) {
      this.clock += 1;
      // our own seq continues from whatever we already hold (e.g. restored from storage)
      const seq = Math.max(this.nextSeq, (this.vv[this.replica] ?? 0) + 1);
      this.nextSeq = seq + 1;
      const op: Op = { id: { c: this.clock, r: this.replica }, seq, shape: e.shape, field: e.field, value: e.value, at };
      this.integrate(op);
      out.push(op);
    }
    this.emit(out);
    return out;
  }

  /** Apply ops from anywhere. Duplicates and any order are fine. Returns the ops that were new. */
  apply(incoming: Op[]): Op[] {
    const fresh: Op[] = [];
    for (const op of incoming) if (this.integrate(op)) fresh.push(op);
    if (fresh.length) this.emit(fresh);
    return fresh;
  }

  private integrate(op: Op): boolean {
    let mine = this.ops.get(op.id.r);
    if (!mine) this.ops.set(op.id.r, (mine = new Map()));
    if (mine.has(op.seq)) return false; // already held: idempotent
    mine.set(op.seq, op);

    // advance the version vector over any now-contiguous run
    let v = this.vv[op.id.r] ?? 0;
    while (mine.has(v + 1)) v += 1;
    this.vv[op.id.r] = v;

    // Lamport: our clock never falls behind anything we have seen
    if (op.id.c > this.clock) this.clock = op.id.c;

    let fields = this.regs.get(op.shape);
    if (!fields) this.regs.set(op.shape, (fields = new Map()));
    const cur = fields.get(op.field);
    if (!cur || compare(op.id, cur.id) > 0) fields.set(op.field, { value: op.value, id: op.id });
    return true;
  }

  /* ── reading ─────────────────────────────────────────────────────────── */

  get version(): VersionVector {
    return { ...this.vv };
  }

  get size(): number {
    let n = 0;
    for (const m of this.ops.values()) n += m.size;
    return n;
  }

  /** Every op we hold that a replica with version vector `theirs` does not. */
  missing(theirs: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [r, m] of this.ops) {
      const have = theirs[r] ?? 0;
      for (const [seq, op] of m) if (seq > have) out.push(op);
    }
    return out.sort((a, b) => compare(a.id, b.id));
  }

  /** True if `theirs` holds something we do not. */
  behind(theirs: VersionVector): boolean {
    return Object.entries(theirs).some(([r, s]) => s > (this.vv[r] ?? 0));
  }

  /** All ops, in Lamport order. */
  log(): Op[] {
    return this.missing({});
  }

  /** The board: every shape and its fields. Shapes whose `deleted` is true are left out. */
  state(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [shape, fields] of this.regs) {
      if (fields.get("deleted")?.value === true) continue;
      const o: Record<string, unknown> = { id: shape };
      for (const [f, reg] of fields) o[f] = reg.value;
      out[shape] = o;
    }
    return out;
  }

  /** One field's current value, if any. */
  get(shape: string, field: string): unknown {
    return this.regs.get(shape)?.get(field)?.value;
  }

  /** A short fingerprint of the board, equal on two replicas iff their boards are equal. */
  hash(): string {
    const s = this.state();
    const keys = Object.keys(s).sort();
    let h = 2166136261;
    const feed = (str: string) => {
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
    };
    for (const k of keys) {
      const o = s[k];
      for (const f of Object.keys(o).sort()) feed(`${k}.${f}=${JSON.stringify(o[f])};`);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  onChange(fn: (ops: Op[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ops: Op[]) {
    for (const fn of this.listeners) fn(ops);
  }
}

/** Rebuild a board from a log, up to (and including) wall clock time `until`. Used by the timeline. */
export function replay(ops: Op[], until = Infinity): Doc {
  const d = new Doc("replay");
  d.apply(ops.filter((o) => o.at <= until));
  return d;
}
