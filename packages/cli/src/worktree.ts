import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commonGitDir, git } from "./git.js";
import { errorText, log } from "./process.js";

const PREFIX = "pixel-commit-wt-";

/**
 * ~/.pixel-commit/worktrees, deliberately NOT the OS temp dir: on Windows,
 * Cypress took ~85s to start in a worktree under %TEMP% vs ~24s for the same
 * worktree under the home folder (likely antivirus scanning of %TEMP%).
 */
function worktreeBase(): string {
  const base = path.join(os.homedir(), ".pixel-commit", "worktrees");
  mkdirSync(base, { recursive: true });
  return realpathSync.native(base);
}

/**
 * Detached checkout of `sha`, with `node_modules` linked to the main repo's.
 * Windows uses a directory junction: real symlinks need admin or Developer
 * Mode, junctions don't.
 */
export function createWorktree(root: string, sha: string, projectDir: string): string {
  const dir = path.join(worktreeBase(), `${PREFIX}${sha.slice(0, 12)}-${process.pid}`);
  git(["worktree", "add", "--detach", dir, sha], root);
  const target = path.join(root, "node_modules");
  if (existsSync(target)) {
    symlinkSync(target, path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  // A real (empty) node_modules in the project folder. Tools that write caches
  // to the nearest node_modules (Vite: .vite, .vite-temp) then write inside
  // the worktree instead of through the junction into the main repo.
  // Packages still resolve upward through the junction.
  const projectModules = path.join(dir, projectDir, "node_modules");
  if (projectDir !== "." && existsSync(path.join(dir, projectDir)) && !existsSync(projectModules)) {
    mkdirSync(projectModules);
  }
  return dir;
}

/**
 * Remove a worktree WITHOUT touching the main repo's node_modules. The
 * node_modules link is unlinked first, so nothing afterwards (git worktree
 * remove, rmSync) can recurse through it into the real folder.
 */
export function removeWorktree(root: string, dir: string): void {
  unlinkIfLink(path.join(dir, "node_modules"));
  try {
    git(["worktree", "remove", "--force", "--force", dir], root);
  } catch (err) {
    log(`git worktree remove failed, deleting folder instead: ${firstLine(errorText(err))}`);
  }
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  try {
    git(["worktree", "prune"], root);
  } catch (err) {
    log(`git worktree prune failed: ${firstLine(errorText(err))}`);
  }
}

/**
 * Remove worktrees left by earlier runs that were killed. Call only while
 * holding the lock: then no other recording of this repo is live, so every
 * pixel-commit worktree of this repo is stale.
 */
export function cleanupStaleWorktrees(root: string): void {
  const found = new Map<string, string>();
  const add = (dir: string) => found.set(normalize(dir), dir);

  // 1. Registered with git.
  for (const line of git(["worktree", "list", "--porcelain"], root).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      const dir = path.resolve(line.slice("worktree ".length));
      if (path.basename(dir).startsWith(PREFIX)) add(dir);
    }
  }
  // 2. Folders whose .git points at this repo (registration already pruned).
  const gitDir = normalize(commonGitDir(root));
  const base = worktreeBase();
  for (const name of safeReaddir(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(base, name);
    const pointer = readGitPointer(dir);
    if (pointer && normalize(pointer).startsWith(gitDir)) add(dir);
  }

  for (const dir of found.values()) {
    log(`Removing stale worktree ${dir}`);
    try {
      removeWorktree(root, dir);
    } catch (err) {
      // e.g. a file still locked by an orphaned process. Don't block this
      // recording (it uses a new folder); the next run tries again.
      log(`Could not remove stale worktree ${dir}: ${firstLine(errorText(err))}`);
    }
  }
  git(["worktree", "prune"], root);
}

function unlinkIfLink(p: string): void {
  try {
    if (lstatSync(p).isSymbolicLink()) unlinkSync(p); // junctions report as symlinks too
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function readGitPointer(dir: string): string | null {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(dir, ".git"), "utf8"));
    return match ? path.resolve(match[1].trim()) : null;
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function normalize(p: string): string {
  const resolved = path.resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("Command failed")) ?? s;
}
