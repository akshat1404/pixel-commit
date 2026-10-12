// Waiting recordings register in .pixel-commit/queue/ so they take the lock
// first-in, first-out, and so a recording can see which newer commits are
// already waiting (to mark itself superseded).

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, isAncestor } from "./git.js";
import { isAlive } from "./process.js";

export interface QueueEntry {
  pid: number;
  sha: string;
  queuedAt: string;
  file: string;
}

function queueDir(stateDir: string): string {
  return path.join(stateDir, "queue");
}

export function enqueue(stateDir: string, sha: string, queuedAt: Date): QueueEntry {
  const dir = queueDir(stateDir);
  mkdirSync(dir, { recursive: true });
  // Name sorts by time; pid breaks ties.
  const file = path.join(dir, `${String(queuedAt.getTime()).padStart(15, "0")}-${process.pid}.json`);
  const entry = { pid: process.pid, sha, queuedAt: queuedAt.toISOString() };
  writeFileSync(file, JSON.stringify(entry));
  return { ...entry, file };
}

export function dequeue(entry: QueueEntry): void {
  try {
    unlinkSync(entry.file);
  } catch {
    // already gone
  }
}

/** Live entries, oldest first. Entries of dead processes are removed. */
export function liveEntries(stateDir: string): QueueEntry[] {
  const dir = queueDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const live: QueueEntry[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const e = JSON.parse(readFileSync(file, "utf8")) as Omit<QueueEntry, "file">;
      if (typeof e.pid === "number" && isAlive(e.pid)) {
        live.push({ ...e, file });
        continue;
      }
    } catch {
      // half-written (owner is still writing it) or corrupt: skip this round
      continue;
    }
    try {
      unlinkSync(file);
    } catch {
      // someone else removed it
    }
  }
  return live;
}

export function isFirst(stateDir: string, entry: QueueEntry): boolean {
  const live = liveEntries(stateDir);
  return live.length === 0 || live[0].file === entry.file;
}

export interface Superseded {
  /** Newer queued commit that builds on this one, or null (no longer on a branch). */
  by: string | null;
  reason: string;
}

/**
 * Called after taking the lock (so every remaining queue entry is newer).
 * Superseded if a newer queued commit descends from this one, or if this
 * commit is no longer reachable from any branch or HEAD (amended, rebased).
 */
export function supersededBy(root: string, stateDir: string, sha: string): Superseded | null {
  for (const e of liveEntries(stateDir)) {
    if (e.sha !== sha && isAncestor(root, sha, e.sha)) {
      return { by: e.sha, reason: `Newer commit ${e.sha.slice(0, 7)} is queued and builds on this one` };
    }
  }
  const branches = git(["branch", "--contains", sha, "--format=%(refname)"], root);
  // HEAD too, so commits made on a detached HEAD (or mid-rebase) still record.
  if (branches === "" && !isAncestor(root, sha, "HEAD")) {
    return { by: null, reason: "Commit is no longer on any branch (amended or rebased away)" };
  }
  return null;
}
