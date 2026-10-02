// ffmpeg helpers. No relative imports: playground/scripts/record-demo.ts
// imports this file directly with Node's type stripping.

import { execFileSync, spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Keep at least this much video after the cut; otherwise the "change" is suspect. */
const MIN_REMAINING_SECONDS = 2;

/**
 * Cypress ships its own ffmpeg inside the binary cache; fall back to one on
 * PATH. `fromDir` is any folder that can resolve the `cypress` package.
 */
export function findFfmpeg(fromDir: string): string {
  try {
    const require = createRequire(path.join(fromDir, "package.json"));
    // `cypress/bin/cypress` is not in the package's exports, so go via its `bin` field.
    const pkgPath = require.resolve("cypress/package.json");
    const { version, bin } = require(pkgPath) as { version: string; bin: { cypress: string } };
    const cli = path.join(path.dirname(pkgPath), bin.cypress);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const cacheDir = execFileSync(process.execPath, [cli, "cache", "path"], {
      encoding: "utf8",
      env,
      windowsHide: true,
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
 * Every Cypress video opens on a static placeholder (~1-25s) while the spec
 * loads. The first scene change is the app appearing; cut everything before
 * it. Re-encodes, because Cypress writes a keyframe only every 10s and a
 * stream copy (-c copy) can only cut on keyframes. Returns seconds removed,
 * or null if nothing was written to `dest` (caller should copy instead).
 */
export function trimLoadingScreen(ffmpeg: string, src: string, dest: string): number | null {
  const detect = spawnSync(
    ffmpeg,
    ["-hide_banner", "-i", src, "-vf", "select='gt(scene,0.1)',showinfo", "-frames:v", "1", "-f", "null", "-"],
    { encoding: "utf8", windowsHide: true },
  );
  const match = /pts_time:(\d+(?:\.\d+)?)/.exec(detect.stderr ?? "");
  const start = match ? Number(match[1]) : 0;
  // Nothing to cut, or nothing left after the cut (a broken video). The
  // placeholder can last 20s+ when the machine is busy, so no fixed cap.
  const duration = videoDurationSeconds(ffmpeg, src);
  if (start < 0.5 || duration === null || start > duration - MIN_REMAINING_SECONDS) return null;

  const encode = spawnSync(
    ffmpeg,
    [
      "-v", "error", "-y",
      "-ss", start.toFixed(3), "-i", src,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-an",
      dest,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (encode.status !== 0) {
    console.warn(`Could not trim video, keeping it untrimmed: ${encode.stderr || encode.error}`);
    return null;
  }
  return start;
}

/** ffmpeg -i prints "Duration: HH:MM:SS.xx" on stderr (and exits 1: no output given). */
export function videoDurationSeconds(ffmpeg: string, file: string): number | null {
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8", windowsHide: true });
  const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr ?? "");
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
