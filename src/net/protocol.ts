import type { Op, ReplicaId, VersionVector } from "../crdt/doc";

/** Who is on a board right now. Ephemeral: never stored, never part of the board. */
export type Presence = {
  replica: ReplicaId;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  /** fingerprint of this replica's board, so everyone can see whether they agree */
  hash: string;
  ops: number;
  offline: boolean;
  /** set locally: we have not heard from this peer for a while (a storm, on either side) */
  quiet?: boolean;
};

export type Msg =
  /** "this is what I hold": answered with whatever the sender is missing */
  | { t: "hello"; from: ReplicaId; vv: VersionVector }
  | { t: "ops"; from: ReplicaId; ops: Op[] }
  | { t: "presence"; from: ReplicaId; p: Presence }
  | { t: "bye"; from: ReplicaId };

/** A way to reach the other replicas: a channel between tabs, a socket, a test harness. */
export interface Wire {
  send(msg: Msg): void;
  onMessage(fn: (msg: Msg) => void): void;
  close(): void;
}
