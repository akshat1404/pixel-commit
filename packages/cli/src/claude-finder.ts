// Finds the Claude Code executable at every run, so users with only the
// VS Code (or Cursor, Windsurf, ...) extension need no extra setup. Never
// cache the result: editors rename the extension folder on every update.

import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_NOT_FOUND = "Claude Code not found: install the VS Code extension or the claude CLI";

const EXE = process.platform === "win32" ? "claude.exe" : "claude";

/** Extension folders of VS Code-family editors, in the order they are searched. */
export function extensionRoots(home = os.homedir()): string[] {
  return [".vscode", ".vscode-insiders", ".cursor", ".windsurf", ".vscode-oss"].map((d) =>
    path.join(home, d, "extensions"),
  );
}

/**
 * 1. `claude` on PATH. 2. The newest `anthropic.claude-code-<version>*`
 * extension folder that contains `resources/native-binary/claude[.exe]`.
 * Returns null if neither exists.
 */
export function findClaude(): string | null {
  return findOnPath(EXE) ?? findInExtensions(extensionRoots());
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOnPath(exe: string, pathEnv = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir.replace(/^"|"$/g, ""), exe);
    if (isExecutableFile(file)) return file;
  }
  return null;
}

interface Candidate {
  dir: string;
  version: number[];
}

export function findInExtensions(roots: string[]): string | null {
  const candidates: Candidate[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    // VS Code lists extensions it is about to delete (after an update) here.
    const obsolete = readObsolete(root);
    for (const name of names) {
      const match = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/i.exec(name);
      if (!match || obsolete.has(name.toLowerCase())) continue;
      candidates.push({ dir: path.join(root, name), version: match[1].split(".").map(Number) });
    }
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  for (const c of candidates) {
    // Look at what the folder actually contains rather than assuming a layout.
    const binDir = path.join(c.dir, "resources", "native-binary");
    let files: string[];
    try {
      files = readdirSync(binDir);
    } catch {
      continue;
    }
    const exe = files.find((f) => f.toLowerCase() === EXE);
    if (exe && isExecutableFile(path.join(binDir, exe))) return path.join(binDir, exe);
  }
  return null;
}

function readObsolete(root: string): Set<string> {
  try {
    const data = JSON.parse(readFileSync(path.join(root, ".obsolete"), "utf8")) as Record<string, boolean>;
    return new Set(Object.keys(data).filter((k) => data[k]).map((k) => k.toLowerCase()));
  } catch {
    return new Set();
  }
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
