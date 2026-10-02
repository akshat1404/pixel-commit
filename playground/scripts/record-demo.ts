// npm run record:demo
// Starts the Vite dev server, runs the date-filter spec headless with video,
// copies the video to <repo>/.pixel-commit/videos/manual/, and prints its
// path, size and duration. Run with plain `node` (Node 22.18+/24 strips types).

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, globSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import cypress from "cypress";

const require = createRequire(import.meta.url);
const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;
const playgroundDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(playgroundDir, "..");
const outDir = path.join(repoRoot, ".pixel-commit", "videos", "manual");
const SPEC = "cypress/e2e/date-filter.cy.ts";
const MAX_TRIM_SECONDS = 15;

async function main() {
  // Set by VS Code (and inherited by its terminals and git hooks). Makes the
  // Cypress Electron binary behave as plain Node: "bad option: --smoke-test".
  delete process.env.ELECTRON_RUN_AS_NODE;

  const server = await startDevServer();

  let results: CypressCommandLine.CypressRunResult | CypressCommandLine.CypressFailedRunResult;
  try {
    results = await cypress.run({
      project: playgroundDir,
      spec: path.join(playgroundDir, SPEC),
      browser: "electron",
      headless: true,
      // Record only the app, not Cypress's command log / URL bar around it.
      runnerUi: false,
    });
  } finally {
    server.kill();
  }

  // Only the "could not start" result has `status`; normal runs report counts instead.
  if ("status" in results) {
    throw new Error(`Cypress could not run: ${results.message}`);
  }

  const video = results.runs[0]?.video;
  if (!video) throw new Error("Cypress finished but produced no video. Is `video: true` set?");

  mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, path.basename(video));
  const ffmpeg = findFfmpeg();
  const trimmed = trimLoadingScreen(ffmpeg, video, dest);
  // Keep Cypress's own copy in sync, so both places show the trimmed video.
  copyFileSync(trimmed === null ? video : dest, trimmed === null ? dest : video);

  const sizeMb = statSync(dest).size / (1024 * 1024);
  const duration = videoDuration(ffmpeg, dest);

  console.log("");
  console.log(`Video:    ${dest}`);
  console.log(`Size:     ${sizeMb.toFixed(2)} MB`);
  console.log(`Duration: ${duration}`);
  console.log(
    `Trimmed:  ${trimmed === null ? "nothing (no loading screen found)" : `${trimmed.toFixed(2)} s loading screen`}`,
  );
  console.log(`Tests:    ${results.totalPassed} passed, ${results.totalFailed} failed`);

  if (results.totalFailed > 0) process.exitCode = 1;
}

/**
 * Vite runs in a child process, not in-process: Vite exits the whole process
 * when stdin ends, and cypress.run() pipes our stdin into Cypress, which ends
 * it. The child gets its own stdin pipe that stays open until we kill it.
 */
async function startDevServer(): Promise<ChildProcess> {
  const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], {
    cwd: playgroundDir,
    stdio: ["pipe", "ignore", "inherit"],
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited early (code ${child.exitCode}).`);
    try {
      if ((await fetch(BASE_URL)).ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`Vite did not respond on ${BASE_URL} within 30s.`);
}

/** Cypress ships its own ffmpeg inside the binary cache; fall back to one on PATH. */
function findFfmpeg(): string {
  try {
    // `cypress/bin/cypress` is not in the package's exports, so go via its `bin` field.
    const pkgPath = require.resolve("cypress/package.json");
    const { version, bin } = require(pkgPath) as { version: string; bin: { cypress: string } };
    const cli = path.join(path.dirname(pkgPath), bin.cypress);
    const cacheDir = execFileSync(process.execPath, [cli, "cache", "path"], {
      encoding: "utf8",
    }).trim();
    const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const pattern = `**/@ffmpeg-installer/${process.platform}-${process.arch}/${exe}`;
    const [found] = globSync(pattern, { cwd: path.join(cacheDir, version) });
    if (found) return path.join(cacheDir, version, found);
  } catch {
    // fall through
  }
  return "ffmpeg";
}

/**
 * Every video opens on a static Cypress placeholder (~4s) while the spec
 * loads. The first scene change is the app appearing; cut everything before
 * it. Re-encodes, because Cypress writes a keyframe only every 10s and a
 * stream copy (-c copy) can only cut on keyframes. Returns seconds removed,
 * or null if nothing was written to `dest` (caller should copy instead).
 */
function trimLoadingScreen(ffmpeg: string, src: string, dest: string): number | null {
  const detect = spawnSync(
    ffmpeg,
    ["-hide_banner", "-i", src, "-vf", "select='gt(scene,0.1)',showinfo", "-frames:v", "1", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const match = /pts_time:(\d+(?:\.\d+)?)/.exec(detect.stderr ?? "");
  const start = match ? Number(match[1]) : 0;
  // Nothing to cut, or a "change" so late it is more likely a broken video.
  if (start < 0.5 || start > MAX_TRIM_SECONDS) return null;

  const encode = spawnSync(
    ffmpeg,
    [
      "-v", "error", "-y",
      "-ss", start.toFixed(3), "-i", src,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-an",
      dest,
    ],
    { encoding: "utf8" },
  );
  if (encode.status !== 0) {
    console.warn(`Could not trim video, keeping it untrimmed: ${encode.stderr || encode.error}`);
    return null;
  }
  return start;
}

/** ffmpeg -i prints "Duration: HH:MM:SS.xx" on stderr (and exits 1: no output given). */
function videoDuration(ffmpeg: string, file: string): string {
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr ?? "");
  if (!match) return "unknown (ffmpeg not found or unreadable video)";
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return `${seconds.toFixed(1)} s`;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
