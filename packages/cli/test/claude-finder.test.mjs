// Run: npm run build -w pixel-commit && npm test -w pixel-commit
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { compareVersions, findInExtensions, findOnPath } from "../dist/claude-finder.js";

const EXE = process.platform === "win32" ? "claude.exe" : "claude";
const tmp = mkdtempSync(path.join(os.tmpdir(), "pc-finder-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function extension(root, name, withBinary = true) {
  const bin = path.join(root, name, "resources", "native-binary");
  mkdirSync(bin, { recursive: true });
  if (withBinary) {
    writeFileSync(path.join(bin, EXE), "");
    chmodSync(path.join(bin, EXE), 0o755);
  }
  return path.join(bin, EXE);
}

test("picks the newest version numerically, not alphabetically", () => {
  const root = path.join(tmp, "vscode", "extensions");
  extension(root, "anthropic.claude-code-2.1.9-win32-x64");
  const newest = extension(root, "anthropic.claude-code-2.1.296-win32-x64");
  extension(root, "someone.else-9.9.9");
  assert.equal(findInExtensions([root]), newest);
});

test("skips a newer folder without the binary and obsolete folders", () => {
  const root = path.join(tmp, "cursor", "extensions");
  const usable = extension(root, "anthropic.claude-code-2.1.100-linux-x64");
  extension(root, "anthropic.claude-code-2.1.300-linux-x64", false); // half-installed
  extension(root, "anthropic.claude-code-2.1.200-linux-x64");
  writeFileSync(path.join(root, ".obsolete"), JSON.stringify({ "anthropic.claude-code-2.1.200-linux-x64": true }));
  assert.equal(findInExtensions([root]), usable);
});

test("searches several editors and missing folders are fine", () => {
  const a = path.join(tmp, "a", "extensions");
  const b = path.join(tmp, "b", "extensions");
  extension(a, "anthropic.claude-code-1.0.0");
  const best = extension(b, "anthropic.claude-code-1.2.0");
  assert.equal(findInExtensions([path.join(tmp, "missing"), a, b]), best);
  assert.equal(findInExtensions([path.join(tmp, "missing")]), null);
});

test("finds claude on PATH", () => {
  const dir = path.join(tmp, "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, EXE), "");
  chmodSync(path.join(dir, EXE), 0o755);
  assert.equal(findOnPath(EXE, [path.join(tmp, "nope"), dir].join(path.delimiter)), path.join(dir, EXE));
  assert.equal(findOnPath(EXE, path.join(tmp, "nope")), null);
});

test("compareVersions", () => {
  assert.ok(compareVersions([2, 1, 296], [2, 1, 9]) > 0);
  assert.ok(compareVersions([2, 2], [2, 1, 999]) > 0);
  assert.equal(compareVersions([1, 0], [1, 0, 0]), 0);
});
