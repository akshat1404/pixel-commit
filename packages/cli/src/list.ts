import { cleanEnvironment, repoRoot } from "./git.js";
import { readRecordings } from "./recorder.js";

export function list(): number {
  cleanEnvironment();
  const recordings = readRecordings(repoRoot());
  if (recordings.length === 0) {
    console.log("No recordings yet.");
    return 0;
  }
  recordings.sort((a, b) => (b.result?.startedAt ?? "￿").localeCompare(a.result?.startedAt ?? "￿"));
  const rows = recordings.map((r) => [
    r.sha.slice(0, 7),
    r.result?.status ?? "incomplete",
    r.result ? `${(r.result.durationMs / 1000).toFixed(1)}s` : "-",
    truncate(r.result?.message.split("\n")[0] ?? "(no result.json: running or interrupted)", 60),
  ]);
  const header = ["SHA", "STATUS", "TIME", "MESSAGE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  for (const row of [header, ...rows]) {
    console.log(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  "));
  }
  return 0;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
