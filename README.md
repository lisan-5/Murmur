# Murmur

**A real-time collaborative whiteboard that never falls apart.** Draw together across tabs, devices and bad networks: lag, lost messages, a laptop shut on a train. When everyone has seen the same edits, everyone has the same board. Every time.

The sync engine is a CRDT written by hand (no Yjs, no Automerge), small enough to read in one sitting ([`src/crdt/doc.ts`](src/crdt/doc.ts)), and the test suite proves it converges.

## Try the demo in 30 seconds

```bash
npm install
npm run dev            # http://localhost:5173
```

1. **Start a board**, then press **Open a second window**.
2. In one window open **Weather** and **call a storm** (you are offline).
3. Draw in both. The top bar shows `2 copies · 2 versions, drifting`.
4. **Let the storm pass.** Within a moment: `2 copies · one board`, and the fingerprints match.
5. Press **Dusk** and drag the slider: the board rebuilds itself from its history.

Two tabs need no server: they talk over `BroadcastChannel`. For other devices, run the server (below).

## How it works

```
   tab A                         tab B                          server (optional)
 ┌──────────┐   ops / hello   ┌──────────┐   ops / hello    ┌──────────────┐
 │ Doc  (A) │ ◄─────────────► │ Doc  (B) │ ◄──────────────► │ Doc (server) │ ── .data/<board>.json
 │ IndexedDB│    presence     │ IndexedDB│                  │  relays msgs │
 └──────────┘                 └──────────┘                  └──────────────┘
      ▲ Weather: wind (lag) · fog (loss) · storm (offline) sits on every wire
```

- **Every field is a register.** A board is a map of shapes; each field of each shape (`x`, `text`, `color`, `deleted`, ...) is a last-writer-wins register.
- **Every edit is an op** stamped with a Lamport clock `(counter, replica)`. Any two stamps are ordered the same way everywhere, so applying ops is commutative, idempotent and associative: order and duplicates do not matter.
- **Version vectors** (highest contiguous op number per replica) let two replicas work out exactly what the other is missing and send only that.
- **Anti-entropy.** Every couple of seconds each replica says `hello` with its version vector. Anything the network dropped is found and resent, so nothing depends on reliable or ordered delivery.
- **Offline first.** Every op is written to IndexedDB; a board reopens with no network at all.
- **The server is just another replica.** It relays, keeps a copy on disk and never decides anything.
- **Presence** (cursors, selections, a fingerprint of each copy) is ephemeral and never stored. Peers you have not heard from stay in the flock, marked quiet, so a storm on either side is visible.

## The numbers (`npm run bench`)

| | |
| --- | --- |
| 10,000 shapes | 100,000 ops, 10.4 MB as JSON |
| merge them into an empty replica | 64 ms, about 1.5 million ops/s |
| random histories, 5 replicas, lossy reordered delivery | 2,000 of 2,000 converged (146,130 ops) |
| property tests (fast-check) | 800 random histories per run, any order, duplicates, partial syncs: all converge |

Measured on a laptop with Node 22. The bench fails the run if a single history disagrees.

## The board

Rectangles, ellipses, arrows that stay pinned to shapes as they move, freehand pen, text and sticky notes. Select, move, resize, marquee and multi-select, snapping to an 8px grid (hold Alt to place freely), infinite pan and zoom, undo and redo, and **Release 1,000 shapes** in the weather panel to load the board up.

| Key | | Key | |
| --- | --- | --- | --- |
| V | select | P | pen |
| H or Space | pan | T | text |
| R | rectangle | N | note |
| O | ellipse | Delete | remove |
| A | arrow | Ctrl Z / Ctrl Shift Z | undo / redo |
| Ctrl + wheel | zoom | arrows | nudge |

On the landing page, the flock is a live boids simulation that tells the story as you scroll. Your pointer is a hawk; press **S** to startle them.

## Server (other devices)

```bash
npm run server                              # ws://localhost:8787
VITE_MURMUR_SERVER=ws://localhost:8787 npm run dev
```

The server needs a host that keeps WebSockets open (Fly.io, Railway, Render, any VM): set `PORT` and, for persistence, `DATA_DIR`. The web app is static (`npm run build` → `dist/`) and can live on Vercel or Netlify; set `VITE_MURMUR_SERVER` at build time to the server's `wss://` address.

## Develop

```bash
npm test          # engine, network and model tests
npm run typecheck
npm run lint
npm run build
npm run bench
```

## Limits, honestly

- Text in notes is a last-writer-wins value: two people typing in the same note at the same moment keep one version. A sequence CRDT for text is the natural next step.
- Ops are kept forever (that is what makes Dusk possible); a long-lived board would want snapshots and log compaction.
