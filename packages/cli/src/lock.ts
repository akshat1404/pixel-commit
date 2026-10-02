import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { isAlive, log, sleep } from "./process.js";

interface LockInfo {
  pid: number;
  sha: string;
  startedAt: string;
}

const POLL_MS = 1000;

/**
 * One recording at a time per repo. `.pixel-commit/lock` is created with
 * O_EXCL; others poll until it is gone (not strictly FIFO). A lock whose owner
 * PID is no longer alive is stale and gets removed. Returns a release function.
 */
export async function acquireLock(stateDir: string, sha: string): Promise<() => void> {
  const file = path.join(stateDir, "lock");
  let announced = false;

  for (;;) {
    try {
      const fd = openSync(file, "wx");
      const info: LockInfo = { pid: process.pid, sha, startedAt: new Date().toISOString() };
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return () => releaseLock(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = readLock(file);
    if (holder === "missing") continue;
    if (holder === "unreadable") {
      // Owner may be mid-write. Only treat as stale once it is clearly old.
      if (ageMs(file) > 10_000) {
        log("Removing unreadable lock file older than 10s");
        removeQuietly(file);
      }
    } else if (!isAlive(holder.pid)) {
      log(`Removing stale lock: pid ${holder.pid} (commit ${holder.sha.slice(0, 7)}) is not running`);
      removeQuietly(file);
      continue;
    } else if (!announced) {
      log(`Waiting: another recording (pid ${holder.pid}, commit ${holder.sha.slice(0, 7)}) is running`);
      announced = true;
    }
    await sleep(POLL_MS);
  }
}

function releaseLock(file: string): void {
  const holder = readLock(file);
  if (typeof holder === "object" && holder.pid === process.pid) removeQuietly(file);
}

function readLock(file: string): LockInfo | "missing" | "unreadable" {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
    return typeof info.pid === "number" ? info : "unreadable";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // someone else removed it
  }
}
