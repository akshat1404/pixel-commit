import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Config, ConfigError, loadConfig, withPort } from "./config.js";
import { cleanEnvironment, commitMessage, repoRoot, resolveCommit } from "./git.js";
import { acquireLock } from "./lock.js";
import { errorText, freePort, killTree, log } from "./process.js";
import type { SessionMessage, SessionRequest, SessionResult } from "./session.js";
import { PatternSpecProvider, type SpecProvider } from "./spec-provider.js";
import { findFfmpeg, trimLoadingScreen } from "./video.js";
import { cleanupStaleWorktrees, createWorktree, removeWorktree } from "./worktree.js";

export type RecordStatus = "passed" | "failed" | "error" | "skipped";

export interface SpecResult {
  spec: string;
  status: "passed" | "failed";
  passes: number;
  failures: number;
  video: string | null;
  tests: { title: string; state: string; error: string | null }[];
}

export interface RecordResult {
  status: RecordStatus;
  sha: string;
  message: string;
  queuedAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  specProvider: string;
  specs: SpecResult[];
  error: string | null;
}

export const STATE_DIR = ".pixel-commit";

export function stateDir(root: string): string {
  return path.join(root, STATE_DIR);
}
export function videosDir(root: string): string {
  return path.join(stateDir(root), "videos");
}
export function logsDir(root: string): string {
  return path.join(stateDir(root), "logs");
}

/**
 * Record `rev` (default HEAD): checkout in a temp worktree, start the dev
 * server on a free port, run Cypress with video, write
 * .pixel-commit/videos/<sha>/ in the main repo. Returns the process exit code.
 */
export async function record(rev: string, provider: SpecProvider = new PatternSpecProvider()): Promise<number> {
  cleanEnvironment();
  // Everything this process spawns inherits it; the post-commit hook exits early on it.
  process.env.PIXEL_COMMIT_RUNNING = "1";

  const root = repoRoot();
  let sha: string;
  try {
    sha = resolveCommit(root, rev);
  } catch {
    console.error(`pixel-commit: "${rev}" is not a commit`);
    return 1;
  }
  const message = commitMessage(root, sha);
  const queuedAt = new Date();
  log(`Recording ${sha.slice(0, 7)} "${message.split("\n")[0]}"`);

  mkdirSync(stateDir(root), { recursive: true });
  const release = await acquireLock(stateDir(root), sha);
  const startedAt = new Date();
  const outDir = path.join(videosDir(root), sha);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let result: RecordResult = {
    status: "error",
    sha,
    message,
    queuedAt: queuedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    specProvider: provider.name,
    specs: [],
    error: null,
  };
  let worktree: string | null = null;

  try {
    const { config, file } = loadConfig(root);
    log(file ? `Config: ${file}` : "Config: none found, using defaults");
    cleanupStaleWorktrees(root);

    worktree = createWorktree(root, sha, config.projectDir);
    log(`Worktree: ${worktree}`);
    const projectDir = path.join(worktree, config.projectDir);
    if (!existsSync(projectDir)) throw new Error(`projectDir "${config.projectDir}" does not exist at this commit`);

    const specs = await provider.getSpecs({ sha, worktreeDir: worktree, projectDir, config });
    if (specs.length === 0) {
      result = { ...result, status: "skipped", error: `No specs from provider "${provider.name}"` };
    } else {
      log(`Specs: ${specs.map((s) => path.relative(projectDir, s)).join(", ")}`);
      const session = await runInSession(config, projectDir, specs);
      log("Cypress finished; copying videos");
      const specResults = copyVideos(session, projectDir, outDir);
      result = {
        ...result,
        specs: specResults,
        error: session.error,
        status: session.error ? "error" : specResults.some((s) => s.status === "failed") ? "failed" : "passed",
      };
    }
  } catch (err) {
    result = { ...result, status: "error", error: err instanceof ConfigError ? err.message : errorText(err) };
  } finally {
    if (worktree) {
      try {
        removeWorktree(root, worktree);
        log("Worktree removed");
      } catch (err) {
        log(`Could not fully remove worktree ${worktree}: ${errorText(err)} (next run retries)`);
      }
    }
    const finishedAt = new Date();
    result = { ...result, finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() };
    writeFileSync(path.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    try {
      applyRetention(root, readKeepLast(root));
    } catch (err) {
      log(`Retention failed: ${errorText(err)}`);
    }
    release();
  }

  log(`Done: ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s -> ${outDir}`);
  if (result.error) log(`Error: ${result.error}`);
  return result.status === "passed" || result.status === "skipped" ? 0 : 1;
}

async function runInSession(config: Config, projectDir: string, specs: string[]): Promise<SessionResult> {
  const port = await freePort();
  const request: SessionRequest = {
    projectDir,
    startCommand: withPort(config.startCommand, port),
    baseUrl: withPort(config.baseUrl, port),
    specs,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], "__session"], {
      cwd: projectDir,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // Detached on every platform. On Windows, libuv puts non-detached
      // children in a kill-on-close job object: killing the recorder would
      // kill the session instantly (no cleanup), while the dev server, started
      // by cmd.exe, silently breaks away from the job and is orphaned.
      // Detached, the session outlives us, sees the IPC disconnect and kills
      // its whole tree itself.
      detached: true,
      windowsHide: true,
    });
    let result: SessionResult | undefined;
    const onSigint = () => {
      log("Interrupted; stopping recording");
      if (child.pid) killTree(child.pid);
    };
    process.once("SIGINT", onSigint);
    child.on("message", (m: SessionMessage) => {
      if (m.type === "done") result = m.result;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onSigint);
      if (result) resolve(result);
      else reject(new Error(`Recording session ended without a result (code ${code}, signal ${signal})`));
    });
    child.send(request);
  });
}

/** Cypress wipes its videos folder on the next run: copy (and trim) right away. */
function copyVideos(session: SessionResult, projectDir: string, outDir: string): SpecResult[] {
  const ffmpeg = session.runs.some((r) => r.video) ? findFfmpeg(projectDir) : "ffmpeg";
  return session.runs.map((run) => {
    let video: string | null = null;
    if (run.video && existsSync(run.video)) {
      video = path.basename(run.video);
      const dest = path.join(outDir, video);
      const trimmed = trimLoadingScreen(ffmpeg, run.video, dest);
      if (trimmed === null) {
        copyFileSync(run.video, dest);
        log(`${video}: copied untrimmed (no loading screen found in the first 15s)`);
      } else log(`${video}: trimmed ${trimmed.toFixed(2)}s loading screen`);
    }
    return {
      spec: run.spec,
      status: run.failures > 0 ? "failed" : "passed",
      passes: run.passes,
      failures: run.failures,
      video,
      tests: run.tests,
    };
  });
}

function readKeepLast(root: string): number {
  try {
    return loadConfig(root).config.keepLast;
  } catch {
    return 30;
  }
}

/** Keep the newest `keepLast` commit folders (by finishedAt); `manual/` is never touched. */
export function applyRetention(root: string, keepLast: number): void {
  const recordings = readRecordings(root);
  // Called while holding the lock, so no other recording is live: a folder
  // without result.json is from a killed run. Its log stays for diagnosis.
  for (const dead of recordings.filter((r) => !r.result)) {
    log(`Retention: removing interrupted recording ${dead.sha.slice(0, 7)} (log kept)`);
    rmSync(dead.dir, { recursive: true, force: true });
  }
  const entries = recordings.filter((r) => r.result);
  entries.sort((a, b) => (b.result!.finishedAt || "").localeCompare(a.result!.finishedAt || ""));
  for (const old of entries.slice(keepLast)) {
    log(`Retention: removing ${old.sha.slice(0, 7)}`);
    rmSync(old.dir, { recursive: true, force: true });
    rmSync(path.join(logsDir(root), `${old.sha}.log`), { force: true });
  }
}

export interface Recording {
  sha: string;
  dir: string;
  result: RecordResult | null;
}

export function readRecordings(root: string): Recording[] {
  const base = videosDir(root);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[0-9a-f]{40}$/.test(d.name))
    .map((d) => {
      const dir = path.join(base, d.name);
      let result: RecordResult | null = null;
      try {
        result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as RecordResult;
      } catch {
        // still recording, or killed before writing a result
      }
      return { sha: d.name, dir, result };
    });
}
