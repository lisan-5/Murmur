/**
 * Offline first: every op a tab learns is written to IndexedDB, keyed by board, replica and
 * seq. Reopening a board, online or not, replays it from here. Several tabs share the store;
 * writing the same op twice is harmless, as everywhere else in Murmur.
 */
import type { Op } from "../crdt/doc";

const DB = "murmur";
const STORE = "ops";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: "k" });
      s.createIndex("board", "board");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let db: Promise<IDBDatabase> | null = null;
const conn = () => (db ??= open());

export async function loadOps(board: string): Promise<Op[]> {
  try {
    const d = await conn();
    return await new Promise((resolve, reject) => {
      const req = d.transaction(STORE).objectStore(STORE).index("board").getAll(board);
      req.onsuccess = () => resolve((req.result as { op: Op }[]).map((x) => x.op));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return []; // private mode or no IndexedDB: the board still works, it just will not persist
  }
}

export async function saveOps(board: string, ops: Op[]): Promise<void> {
  if (!ops.length) return;
  try {
    const d = await conn();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      for (const op of ops) s.put({ k: `${board}|${op.id.r}|${op.seq}`, board, op });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* see above */
  }
}
