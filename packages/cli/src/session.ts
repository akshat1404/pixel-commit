// Runs in a child process of the recorder (`pixel-commit __session`), talking
// over IPC. It starts the dev server and runs Cypress (several times, for
// repairs), so both are its descendants. If the recorder dies (killed,
// crash), the IPC channel disconnects and this process kills its whole tree:
// no orphaned Vite/Cypress keeps files in the worktree open, and nothing has
// to kill processes by remembered PID later.

import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { errorText, killTree, log, waitForUrl } from "./process.js";

/** Recorder -> session. */
export type SessionCommand =
  | { type: "start"; projectDir: string; startCommand: string; baseUrl: string }
  | { type: "run"; specs: string[]; video: boolean }
  | { type: "stop" };

/** Session -> recorder. */
export type SessionReply =
  | { type: "ready" }
  | { type: "failed"; error: string }
  | { type: "ran"; result: SessionResult };

export interface TestOutcome {
  title: string;
  state: string;
  error: string | null;
}

export interface SpecRun {
  /** Spec path relative to the project folder. */
  spec: string;
  video: string | null;
  screenshots: string[];
  passes: number;
  failures: number;
  tests: TestOutcome[];
}

/** `error` set = Cypress could not run. Otherwise per-spec results. */
export interface SessionResult {
  error: string | null;
  runs: SpecRun[];
}

// Only the fields we read from cypress.run()'s result (see Cypress module API docs).
interface CypressRunResult {
  runs: Array<{
    spec: { relative: string };
    video: string | null;
    screenshots: Array<{ path: string }>;
    stats: { passes: number; failures: number };
    tests: Array<{ title: string[]; state: string; displayError: string | null }>;
  }>;
}
interface CypressFailedRunResult {
  status: "failed";
  message: string;
}
interface CypressModule {
  run(options: Record<string, unknown>): Promise<CypressRunResult | CypressFailedRunResult>;
}

const SERVER_TIMEOUT_MS = 60_000;

export async function runSession(): Promise<void> {
  let server: ChildProcess | undefined;
  let start: Extract<SessionCommand, { type: "start" }> | undefined;
  let stopping = false;

  const reply = (m: SessionReply) => process.send!(m);
  const shutdown = () => {
    stopping = true;
    if (server?.pid) killTree(server.pid);
  };

  process.on("disconnect", () => {
    if (stopping) return;
    log("Recorder went away; stopping dev server and Cypress");
    killTree(process.pid);
  });

  process.on("message", async (raw) => {
    const cmd = raw as SessionCommand;
    if (cmd.type === "start") {
      start = cmd;
      try {
        log(`Starting dev server: ${cmd.startCommand}`);
        server = startServer(cmd.projectDir, cmd.startCommand);
        const srv = server;
        await waitForUrl(cmd.baseUrl, SERVER_TIMEOUT_MS, () => (srv.exitCode !== null ? `exit code ${srv.exitCode}` : null));
        log(`Dev server up at ${cmd.baseUrl}`);
        reply({ type: "ready" });
      } catch (err) {
        reply({ type: "failed", error: errorText(err) });
      }
    } else if (cmd.type === "run") {
      let result: SessionResult;
      try {
        result = await runCypress(start!.projectDir, start!.baseUrl, cmd.specs, cmd.video);
      } catch (err) {
        result = { error: errorText(err), runs: [] };
      }
      reply({ type: "ran", result });
    } else if (cmd.type === "stop") {
      shutdown();
      process.disconnect();
      process.exit(0);
    }
  });
}

function startServer(projectDir: string, startCommand: string): ChildProcess {
  return spawn(startCommand, {
    cwd: projectDir,
    shell: true,
    // stdin stays an open pipe: Vite exits when its stdin ends.
    stdio: ["pipe", "inherit", "inherit"],
    detached: process.platform !== "win32", // own process group, for killTree on POSIX
    windowsHide: true,
  });
}

async function runCypress(projectDir: string, baseUrl: string, specs: string[], video: boolean): Promise<SessionResult> {
  // Cypress comes from the project being recorded, not from pixel-commit.
  const require = createRequire(path.join(projectDir, "package.json"));
  const cypress = require("cypress") as CypressModule;
  log(`Running Cypress on ${specs.length} spec(s), video ${video ? "on" : "off"}`);
  const res = await cypress.run({
    project: projectDir,
    // Module API documents `spec` as a string; several specs are comma-joined, like the CLI.
    spec: specs.join(","),
    browser: "electron",
    headless: true,
    runnerUi: false,
    config: { baseUrl, video },
  });
  if ("status" in res) return { error: `Cypress could not run: ${res.message}`, runs: [] };
  return {
    error: null,
    runs: res.runs.map((run) => ({
      spec: run.spec.relative,
      video: run.video,
      screenshots: (run.screenshots ?? []).map((s) => s.path),
      passes: run.stats.passes,
      failures: run.stats.failures,
      tests: run.tests.map((t) => ({ title: t.title.join(" > "), state: t.state, error: t.displayError ?? null })),
    })),
  };
}
