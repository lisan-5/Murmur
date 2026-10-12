/**
 * The Murmur server: one more replica, the one that never sleeps.
 *
 * It relays every message to the other sockets on the same board, keeps its own copy of each
 * board (applying ops exactly like a browser does) and writes it to disk, so a board outlives
 * every tab. It never edits, and it is never trusted to order anything: the CRDT does that.
 *
 *   PORT=8787 npm run server        ws://localhost:8787/?board=<id>
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Doc, type Op } from "../src/crdt/doc";
import type { Msg } from "../src/net/protocol";

const PORT = Number(process.env.PORT ?? 8787);
const DATA = process.env.DATA_DIR ?? join(process.cwd(), ".data");
mkdirSync(DATA, { recursive: true });

type Room = { doc: Doc; sockets: Set<WebSocket>; dirty: boolean };
const rooms = new Map<string, Room>();
const safe = (board: string) => board.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";

function room(board: string): Room {
  let r = rooms.get(board);
  if (r) return r;
  const doc = new Doc("server");
  const file = join(DATA, `${board}.json`);
  if (existsSync(file)) {
    try {
      doc.apply(JSON.parse(readFileSync(file, "utf8")) as Op[]);
    } catch {
      console.warn(`could not read ${file}, starting empty`);
    }
  }
  r = { doc, sockets: new Set(), dirty: false };
  rooms.set(board, r);
  return r;
}

// persist dirty boards every few seconds
setInterval(() => {
  for (const [board, r] of rooms) {
    if (!r.dirty) continue;
    writeFileSync(join(DATA, `${board}.json`), JSON.stringify(r.doc.log()));
    r.dirty = false;
    if (!r.sockets.size) rooms.delete(board);
  }
}, 3000);

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`murmur server: ${rooms.size} boards open\n`);
});
const wss = new WebSocketServer({ server: http, maxPayload: 4 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  const board = safe(new URL(req.url ?? "/", "http://x").searchParams.get("board") ?? "default");
  const r = room(board);
  r.sockets.add(ws);

  ws.on("message", (raw) => {
    let m: Msg;
    try {
      m = JSON.parse(String(raw)) as Msg;
    } catch {
      return;
    }
    // relay to everyone else on the board
    for (const other of r.sockets) if (other !== ws && other.readyState === other.OPEN) other.send(String(raw));
    // and keep our own copy
    if (m.t === "ops") {
      if (r.doc.apply(m.ops).length) r.dirty = true;
    } else if (m.t === "hello") {
      const gap = r.doc.missing(m.vv);
      if (gap.length) ws.send(JSON.stringify({ t: "ops", from: "server", ops: gap } satisfies Msg));
      if (r.doc.behind(m.vv)) ws.send(JSON.stringify({ t: "hello", from: "server", vv: r.doc.version } satisfies Msg));
    }
  });
  ws.on("close", () => r.sockets.delete(ws));
});

http.listen(PORT, () => console.log(`murmur server on ws://localhost:${PORT}  (data in ${DATA})`));
