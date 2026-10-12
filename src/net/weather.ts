/**
 * The weather between this replica and the flock: a Wire wrapped in bad conditions.
 *   wind   delay on every message, with gusts (jitter), in both directions
 *   fog    a share of messages simply never arrive
 *   storm  cut off entirely; nothing in or out until it passes
 * The sync engine is never told. It has to cope, which is the point.
 */
import type { Msg, Wire } from "./protocol";

export type Conditions = { wind: number; fog: number; storm: boolean };
export type WeatherStats = { out: number; in: number; lost: number; held: number; inFlight: number };

export class Weather implements Wire {
  conditions: Conditions = { wind: 0, fog: 0, storm: false };
  readonly stats: WeatherStats = { out: 0, in: 0, lost: 0, held: 0, inFlight: 0 };
  private fns: ((m: Msg) => void)[] = [];
  private inner: Wire;
  private random: () => number;

  constructor(inner: Wire, random: () => number = Math.random) {
    this.inner = inner;
    this.random = random;
    inner.onMessage((m) => this.pass(m, (x) => this.fns.forEach((f) => f(x)), "in"));
  }

  send(msg: Msg) {
    this.pass(msg, (x) => this.inner.send(x), "out");
  }

  onMessage(fn: (m: Msg) => void) {
    this.fns.push(fn);
  }

  close() {
    this.inner.close();
  }

  private pass(m: Msg, deliver: (m: Msg) => void, dir: "in" | "out") {
    const { wind, fog, storm } = this.conditions;
    // presence still flows in fog (it is resent constantly anyway), but not through a storm
    if (storm) {
      this.stats.held += 1;
      return;
    }
    if (m.t !== "presence" && fog > 0 && this.random() < fog) {
      this.stats.lost += 1;
      return;
    }
    this.stats[dir] += 1;
    if (wind <= 0) return deliver(m);
    this.stats.inFlight += 1;
    const gust = wind * (0.6 + this.random() * 0.8);
    setTimeout(() => {
      this.stats.inFlight -= 1;
      deliver(m);
    }, gust);
  }
}

/** Wires between tabs of the same browser: no server needed for the demo. */
export class TabWire implements Wire {
  private ch: BroadcastChannel;
  constructor(board: string) {
    this.ch = new BroadcastChannel(`murmur:${board}`);
  }
  send(msg: Msg) {
    this.ch.postMessage(msg);
  }
  onMessage(fn: (m: Msg) => void) {
    this.ch.addEventListener("message", (e) => fn(e.data as Msg));
  }
  close() {
    this.ch.close();
  }
}

/** A socket to the Murmur server (another replica that keeps the board on disk). Reconnects by itself. */
export class SocketWire implements Wire {
  private ws: WebSocket | null = null;
  private fns: ((m: Msg) => void)[] = [];
  private closed = false;
  private tries = 0;
  private url: string;
  private onOpen: () => void;
  status: "connecting" | "open" | "down" = "connecting";

  constructor(url: string, onOpen: () => void) {
    this.url = url;
    this.onOpen = onOpen;
    this.connect();
  }
  private connect() {
    if (this.closed) return;
    this.status = "connecting";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.status = "open";
      this.onOpen();
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as Msg;
        this.fns.forEach((f) => f(m));
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      this.status = "down";
      if (this.closed) return;
      this.tries += 1;
      setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.tries));
    };
  }
  send(msg: Msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  onMessage(fn: (m: Msg) => void) {
    this.fns.push(fn);
  }
  close() {
    this.closed = true;
    this.ws?.close();
  }
}
