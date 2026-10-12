import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AiSpecProvider } from "./ai-provider.js";
import { type Config, ConfigError, loadConfig, withPort } from "./config.js";
import { cleanEnvironment, commitMessage, repoRoot, resolveCommit } from "./git.js";
import { acquireLock } from "./lock.js";
import { errorText, freePort, killTree, log } from "./process.js";
import { dequeue, enqueue, supersededBy } from "./queue.js";
import type { SessionCommand, SessionReply, SessionResult, SpecRun } from "./session.js";
import { type OutputKind, PatternSpecProvider, type SpecContext, type SpecProvider } from "./spec-provider.js";
import { findFfmpeg, trimLoadingScreen } from "./video.js";
import { cleanupStaleWorktrees, createWorktree, removeWorktree } from "./worktree.js";

export type RecordStatus = "passed" | "failed" | "error" | "skipped" | "superseded";

/** A failing spec is repaired at most this many times (so up to 3 attempts). */
const MAX_REPAIRS = 2;

export interface SpecResult {
  spec: string;
  status: "passed" | "failed";
  /** Versions of the spec that ran (1 = no repair). */
  attempts: number;
  passes: number;
  failures: number;
  video: string | null;
  /** Paths relative to the commit folder, e.g. screenshots/badge.png. */
  screenshots: string[];
  tests: { title: string; state: string; error: string | null }[];
}

export interface RecordResult {
  status: RecordStatus;
  sha: string;
  message: string;
  kind: OutputKind | null;
  reason: string | null;
  queuedAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  specProvider: string | null;
  /** AI provider only: { command, calls, durationMs, costUsd (CLI estimate) }. */
  generator: Record<string, unknown> | null;
  diffTruncated: boolean;
  supersededBy: string | null;
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
 * Record `rev` (default HEAD): checkout in a temp worktree, ask the spec
 * provider what to run, start the dev server on a free port, run Cypress,
 * write .pixel-commit/videos/<sha>/ in the main repo. Returns the exit code.
 */
export async function record(rev: string): Promise<number> {
  cleanEnvironment();
  // Everything this process spawns (dev server, Cypress, the generator CLI)
  // inherits it; the post-commit hook exits early on it.
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
  const entry = enqueue(stateDir(root), sha, queuedAt);
  let release: () => void;
  try {
    release = await acquireLock(stateDir(root), sha, entry);
  } catch (err) {
    dequeue(entry);
    throw err;
  }
  const startedAt = new Date();
  const outDir = path.join(videosDir(root), sha);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let result: RecordResult = {
    status: "error",
    sha,
    message,
    kind: null,
    reason: null,
    queuedAt: queuedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    specProvider: null,
    generator: null,
    diffTruncated: false,
    supersededBy: null,
    specs: [],
    error: null,
  };
  let worktree: string | null = null;
  let provider: SpecProvider | null = null;

  try {
    const { config, file } = loadConfig(root);
    log(file ? `Config: ${file}` : "Config: none found, using defaults");

    const superseded = supersededBy(root, stateDir(root), sha);
    if (superseded) {
      log(`Superseded: ${superseded.reason}`);
      result = { ...result, status: "superseded", reason: superseded.reason, supersededBy: superseded.by };
    } else {
      cleanupStaleWorktrees(root);
      worktree = createWorktree(root, sha, config.projectDir);
      log(`Worktree: ${worktree}`);
      const projectDir = path.join(worktree, config.projectDir);
      if (!existsSync(projectDir)) throw new Error(`projectDir "${config.projectDir}" does not exist at this commit`);

      provider = config.specProvider === "ai" ? new AiSpecProvider(path.join(outDir, "specs")) : new PatternSpecProvider();
      result.specProvider = provider.name;
      const ctx: SpecContext = { sha, worktreeDir: worktree, projectDir, config };
      const plan = await provider.getSpecs(ctx);
      result = { ...result, kind: plan.kind, reason: plan.reason };

      if (plan.kind === "none" || plan.specs.length === 0) {
        result.status = "skipped";
        log(`Skipped: ${plan.reason}`);
      } else {
        log(`Specs (${plan.kind}): ${plan.specs.map((s) => path.relative(projectDir, s)).join(", ")}`);
        const specs = await runWithRepairs(ctx, provider, plan.specs, plan.kind === "video", outDir);
        result.specs = specs.results;
        result.error = specs.error;
        result.status = specs.error ? "error" : specs.results.some((s) => s.status === "failed") ? "failed" : "passed";
      }
    }
  } catch (err) {
    result = { ...result, status: "error", error: err instanceof ConfigError ? err.message : errorText(err) };
  } finally {
    if (provider?.report) Object.assign(result, provider.report());
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
  return ["passed", "skipped", "superseded"].includes(result.status) ? 0 : 1;
}

/**
 * Start the dev server once, run all specs, then repair and re-run failing
 * specs (only those) up to MAX_REPAIRS times. Artifacts are copied out after
 * every run, because Cypress wipes its videos/screenshots folders on the next.
 */
async function runWithRepairs(
  ctx: SpecContext,
  provider: SpecProvider,
  specs: string[],
  video: boolean,
  outDir: string,
): Promise<{ results: SpecResult[]; error: string | null }> {
  const session = await Session.start(ctx.config, ctx.projectDir);
  const results = new Map<string, SpecResult>();
  const ffmpeg = video ? findFfmpeg(ctx.projectDir) : "ffmpeg";
  try {
    let toRun = specs;
    for (let attempt = 1; ; attempt++) {
      const run = await session.run(toRun, video);
      log("Cypress finished; copying artifacts");
      if (run.error) return { results: [...results.values()], error: run.error };
      for (const r of run.runs) {
        const abs = path.join(ctx.projectDir, r.spec);
        results.set(abs, collect(r, attempt, results.get(abs), ffmpeg, outDir));
      }
      const failing = toRun.filter((s) => results.get(s)?.status === "failed");
      if (failing.length === 0 || !provider.repair || attempt > MAX_REPAIRS) break;

      toRun = [];
      for (const spec of failing) {
        const error = results.get(spec)!.tests.filter((t) => t.error).map((t) => `${t.title}\n${t.error}`).join("\n\n");
        log(`Repairing ${path.basename(spec)} (attempt ${attempt + 1})`);
        if (await provider.repair(ctx, spec, error || "The spec failed without a test error.")) toRun.push(spec);
      }
      if (toRun.length === 0) break;
    }
  } finally {
    await session.stop();
    removeIfEmpty(path.join(outDir, "screenshots"));
  }
  return { results: specs.map((s) => results.get(s)).filter((r): r is SpecResult => Boolean(r)), error: null };
}

function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  } catch {
    // missing
  }
}

/** Copy (and trim) one spec run's video and screenshots; replaces an earlier attempt's. */
function collect(run: SpecRun, attempt: number, previous: SpecResult | undefined, ffmpeg: string, outDir: string): SpecResult {
  for (const old of previous?.screenshots ?? []) rmSync(path.join(outDir, old), { force: true });

  let video: string | null = null;
  if (run.video && existsSync(run.video)) {
    video = path.basename(run.video);
    const dest = path.join(outDir, video);
    const trimmed = trimLoadingScreen(ffmpeg, run.video, dest);
    if (trimmed === null) {
      copyFileSync(run.video, dest);
      log(`${video}: copied untrimmed (no loading screen found)`);
    } else log(`${video}: trimmed ${trimmed.toFixed(2)}s loading screen`);
  }

  const screenshots: string[] = [];
  if (run.screenshots.length > 0) mkdirSync(path.join(outDir, "screenshots"), { recursive: true });
  for (const shot of run.screenshots) {
    if (!existsSync(shot)) continue;
    let rel = path.join("screenshots", path.basename(shot));
    for (let n = 2; screenshots.includes(rel); n++) rel = path.join("screenshots", `${n}-${path.basename(shot)}`);
    copyFileSync(shot, path.join(outDir, rel));
    screenshots.push(rel.replace(/\\/g, "/"));
  }

  return {
    spec: run.spec,
    status: run.failures > 0 ? "failed" : "passed",
    attempts: attempt,
    passes: run.passes,
    failures: run.failures,
    video,
    screenshots,
    tests: run.tests,
  };
}

/** Client side of the session process (see session.ts). */
class Session {
  private waiters: Array<(r: SessionReply) => void> = [];
  private exited: Promise<void>;
  private exitError: Error | null = null;

  private constructor(private child: ChildProcess) {
    child.on("message", (m: SessionReply) => {
      this.waiters.shift()?.(m);
    });
    this.exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        this.exitError = new Error(`Recording session ended unexpectedly (code ${code}, signal ${signal})`);
        for (const w of this.waiters.splice(0)) w({ type: "failed", error: this.exitError.message });
        resolve();
      });
    });
  }

  static async start(config: Config, projectDir: string): Promise<Session> {
    const port = await freePort();
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
    const onSigint = () => {
      log("Interrupted; stopping recording");
      if (child.pid) killTree(child.pid);
    };
    process.once("SIGINT", onSigint);
    child.on("exit", () => process.off("SIGINT", onSigint));

    const session = new Session(child);
    const reply = await session.send({
      type: "start",
      projectDir,
      startCommand: withPort(config.startCommand, port),
      baseUrl: withPort(config.baseUrl, port),
    });
    if (reply.type !== "ready") {
      await session.stop();
      throw new Error(reply.type === "failed" ? reply.error : "unexpected reply from session");
    }
    return session;
  }

  async run(specs: string[], video: boolean): Promise<SessionResult> {
    const reply = await this.send({ type: "run", specs, video });
    if (reply.type === "ran") return reply.result;
    return { error: reply.type === "failed" ? reply.error : "unexpected reply from session", runs: [] };
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.connected) this.child.send({ type: "stop" } satisfies SessionCommand);
    await this.exited;
  }

  private send(cmd: SessionCommand): Promise<SessionReply> {
    if (this.exitError) return Promise.resolve({ type: "failed", error: this.exitError.message });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.child.send(cmd);
    });
  }
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
