import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { cleanEnvironment, repoRoot, resolveCommit } from "./git.js";
import { logsDir } from "./recorder.js";

/**
 * `record <sha> --detach`, used by the post-commit hook. Starts the real
 * recorder as a detached background process writing to
 * .pixel-commit/logs/<sha>.log, then returns at once so `git commit` doesn't
 * wait. The child gets no pipes shared with git: stdin ignored, output to the
 * log file.
 */
export function launchDetached(rev: string): number {
  if (process.env.PIXEL_COMMIT_RUNNING === "1") return 0; // loop guard (the hook checks too)
  cleanEnvironment();
  const root = repoRoot();
  const sha = resolveCommit(root, rev);
  mkdirSync(logsDir(root), { recursive: true });
  const logFile = path.join(logsDir(root), `${sha}.log`);
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, [process.argv[1], "record", sha], {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  console.log(`${new Date().toISOString()} ${sha.slice(0, 7)}: recording in background (pid ${child.pid}), log ${logFile}`);
  return 0;
}
