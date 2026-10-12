/**
 * Keeps one Doc in step with the others over a Wire.
 *
 *  - local edits are sent at once;
 *  - a "hello" carries our version vector; whoever hears it replies with exactly what we
 *    are missing, and says hello back if we hold something they do not;
 *  - every couple of seconds we say hello again (anti-entropy), so anything the network
 *    dropped is found and resent. Nothing relies on delivery being reliable or ordered.
 */
import type { Doc, Op } from "../crdt/doc";
import type { Msg, Presence, Wire } from "./protocol";

export type SyncStats = { sent: number; received: number; fresh: number; duplicates: number; hellos: number };

export class Sync {
  readonly stats: SyncStats = { sent: 0, received: 0, fresh: 0, duplicates: 0, hellos: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;
  private off: () => void;
  private peers = new Map<string, { p: Presence; seen: number }>();
  private presenceFns = new Set<() => void>();
  private opFns = new Set<(ops: Op[], from: string) => void>();
  private doc: Doc;
  private wires: Wire[];

  constructor(doc: Doc, wires: Wire[], interval = 2000) {
    this.doc = doc;
    this.wires = wires;
    for (const w of wires) w.onMessage((m) => this.receive(m));
    // our own edits go out straight away
    this.off = doc.onChange((ops) => {
      if (ops.length && ops[0].id.r === doc.replica) this.send({ t: "ops", from: doc.replica, ops: ops.filter((o) => o.id.r === doc.replica) });
    });
    this.timer = setInterval(() => {
      this.hello();
      // peers who go quiet stay in the flock (marked quiet): in a storm you still want to see them.
      // Only a minute of silence, or a goodbye, takes them out.
      const now = Date.now();
      for (const [id, v] of this.peers) if (now - v.seen > 60000) this.peers.delete(id);
      this.presenceFns.forEach((f) => f());
    }, interval);
    this.hello();
  }

  hello() {
    this.stats.hellos += 1;
    this.send({ t: "hello", from: this.doc.replica, vv: this.doc.version });
  }

  announce(p: Presence) {
    this.send({ t: "presence", from: this.doc.replica, p });
  }

  get presence(): Presence[] {
    const now = Date.now();
    return [...this.peers.values()].map((v) => ({ ...v.p, quiet: now - v.seen > 4000 }));
  }

  onPresence(fn: () => void) {
    this.presenceFns.add(fn);
    return () => this.presenceFns.delete(fn);
  }

  /** Remote ops as they land, with who sent them (for the weather log). */
  onRemoteOps(fn: (ops: Op[], from: string) => void) {
    this.opFns.add(fn);
    return () => this.opFns.delete(fn);
  }

  private send(m: Msg) {
    if (m.t === "ops") this.stats.sent += m.ops.length;
    for (const w of this.wires) w.send(m);
  }

  private receive(m: Msg) {
    if (m.from === this.doc.replica) return;
    switch (m.t) {
      case "hello": {
        const gap = this.doc.missing(m.vv);
        if (gap.length) this.send({ t: "ops", from: this.doc.replica, ops: gap });
        if (this.doc.behind(m.vv)) this.send({ t: "hello", from: this.doc.replica, vv: this.doc.version });
        break;
      }
      case "ops": {
        this.stats.received += m.ops.length;
        const fresh = this.doc.apply(m.ops);
        this.stats.fresh += fresh.length;
        this.stats.duplicates += m.ops.length - fresh.length;
        if (fresh.length) this.opFns.forEach((f) => f(fresh, m.from));
        break;
      }
      case "presence":
        this.peers.set(m.from, { p: m.p, seen: Date.now() });
        this.presenceFns.forEach((f) => f());
        break;
      case "bye":
        if (this.peers.delete(m.from)) this.presenceFns.forEach((f) => f());
        break;
    }
  }

  close() {
    this.send({ t: "bye", from: this.doc.replica });
    clearInterval(this.timer);
    this.off();
    for (const w of this.wires) w.close();
  }
}
