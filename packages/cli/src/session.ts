// Runs in a child process of the recorder (`pixel-commit __session`), talking
// over IPC. It starts the dev server and Cypress, so both are its descendants.
// If the recorder dies (killed, crash), the IPC channel disconnects and this
// process kills its whole tree: no orphaned Vite/Cypress keeps files in the
// worktree open, and nothing has to kill processes by remembered PID later.

import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { errorText, killTree, log, waitForUrl } from "./process.js";

export interface SessionRequest {
  projectDir: string;
  startCommand: string;
  baseUrl: string;
  specs: string[];
}

export interface TestOutcome {
  title: string;
  state: string;
  error: string | null;
}

export interface SpecRun {
  spec: string;
  video: string | null;
  passes: number;
  failures: number;
  tests: TestOutcome[];
}

/** `error` set = could not run (server, Cypress startup). Otherwise per-spec results. */
export interface SessionResult {
  error: string | null;
  runs: SpecRun[];
}

export type SessionMessage = { type: "done"; result: SessionResult };

// Only the fields we read from cypress.run()'s result (see Cypress module API docs).
interface CypressRunResult {
  runs: Array<{
    spec: { relative: string };
    video: string | null;
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
  let finished = false;
  process.on("disconnect", () => {
    if (finished) return;
    log("Recorder went away; stopping dev server and Cypress");
    killTree(process.pid);
  });

  const request = await new Promise<SessionRequest>((resolve) => process.once("message", (m) => resolve(m as SessionRequest)));
  let server: ChildProcess | undefined;
  let result: SessionResult;
  try {
    server = startServer(request);
    const srv = server;
    await waitForUrl(request.baseUrl, SERVER_TIMEOUT_MS, () =>
      srv.exitCode !== null ? `exit code ${srv.exitCode}` : null,
    );
    log(`Dev server up at ${request.baseUrl}`);
    result = await runCypress(request);
  } catch (err) {
    result = { error: errorText(err), runs: [] };
  } finally {
    if (server?.pid) killTree(server.pid);
  }

  finished = true;
  const message: SessionMessage = { type: "done", result };
  process.send!(message, () => process.exit(0));
}

function startServer(request: SessionRequest): ChildProcess {
  log(`Starting dev server: ${request.startCommand}`);
  return spawn(request.startCommand, {
    cwd: request.projectDir,
    shell: true,
    // stdin stays an open pipe: Vite exits when its stdin ends.
    stdio: ["pipe", "inherit", "inherit"],
    detached: process.platform !== "win32", // own process group, for killTree on POSIX
    windowsHide: true,
  });
}

async function runCypress(request: SessionRequest): Promise<SessionResult> {
  // Cypress comes from the project being recorded, not from pixel-commit.
  const require = createRequire(path.join(request.projectDir, "package.json"));
  const cypress = require("cypress") as CypressModule;
  log(`Running Cypress on ${request.specs.length} spec(s)`);
  const res = await cypress.run({
    project: request.projectDir,
    // Module API documents `spec` as a string; several specs are comma-joined, like the CLI.
    spec: request.specs.join(","),
    browser: "electron",
    headless: true,
    runnerUi: false,
    config: { baseUrl: request.baseUrl, video: true },
  });
  if ("status" in res) return { error: `Cypress could not run: ${res.message}`, runs: [] };
  return {
    error: null,
    runs: res.runs.map((run) => ({
      spec: run.spec.relative,
      video: run.video,
      passes: run.stats.passes,
      failures: run.stats.failures,
      tests: run.tests.map((t) => ({ title: t.title.join(" > "), state: t.state, error: t.displayError ?? null })),
    })),
  };
}
