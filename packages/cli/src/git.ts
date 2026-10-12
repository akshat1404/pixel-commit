import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

/** Run git and return trimmed stdout. Throws with git's stderr in the message. */
export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/**
 * Git exports GIT_DIR, GIT_INDEX_FILE, etc. to hooks. Left in place they make
 * git commands aimed at another worktree act on the hook's repo/index instead
 * (githooks(5) says to clear them). Also drops ELECTRON_RUN_AS_NODE, which VS
 * Code sets and which breaks the Cypress Electron binary.
 */
export function cleanEnvironment(): void {
  let names: string[];
  try {
    names = git(["rev-parse", "--local-env-vars"], process.cwd()).split(/\r?\n/);
  } catch {
    names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];
  }
  for (const name of names) if (name) delete process.env[name];
  delete process.env.ELECTRON_RUN_AS_NODE;
}

/** Root of the working tree the command was run in. */
export function repoRoot(cwd = process.cwd()): string {
  return path.resolve(git(["rev-parse", "--show-toplevel"], cwd));
}

/** Absolute path of the shared .git directory (same for all worktrees). */
export function commonGitDir(root: string): string {
  return path.resolve(root, git(["rev-parse", "--git-common-dir"], root));
}

export function resolveCommit(root: string, rev: string): string {
  return git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], root);
}

export function commitMessage(root: string, sha: string): string {
  return git(["log", "-1", "--format=%B", sha], root);
}

/** Run git and return raw stdout (untrimmed, large output allowed). */
export function gitRaw(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

/** `git merge-base --is-ancestor a b`: true if a is b or an ancestor of b. */
export function isAncestor(root: string, a: string, b: string): boolean {
  const res = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root, stdio: "ignore", windowsHide: true });
  return res.status === 0;
}
