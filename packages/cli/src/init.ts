import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, ConfigError, DEFAULT_CONFIG, loadConfig } from "./config.js";
import { cleanEnvironment, commonGitDir, git, repoRoot } from "./git.js";
import { STATE_DIR } from "./recorder.js";

const BEGIN = "# >>> pixel-commit >>>";
const END = "# <<< pixel-commit <<<";

/** Safe to re-run: keeps an existing config, replaces its own hook block in place. */
export function init(): number {
  cleanEnvironment();
  const root = repoRoot();

  // 1. Config
  const configPath = path.join(root, CONFIG_FILE);
  if (existsSync(configPath)) {
    try {
      loadConfig(root);
      console.log(`Config: ${CONFIG_FILE} exists and is valid`);
    } catch (err) {
      console.error(err instanceof ConfigError ? err.message : String(err));
      return 1;
    }
  } else {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    console.log(`Config: created ${CONFIG_FILE} with defaults`);
  }

  // 2. Hook
  const hooksDir = path.resolve(root, git(["rev-parse", "--git-path", "hooks"], root));
  const block = hookBlock();
  if (isTrackedLocation(root, hooksDir)) {
    // e.g. Husky (.husky/). The block holds absolute, machine-specific paths;
    // it must not end up in a committed file.
    console.error(
      [
        `Hooks directory ${hooksDir} is inside the working tree (core.hooksPath), so it is`,
        "probably committed. pixel-commit will not write machine-specific paths into it.",
        "Add this to a local, untracked post-commit hook yourself:",
        "",
        block,
      ].join("\n"),
    );
    return 1;
  }

  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "post-commit");
  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8").replaceAll("\r\n", "\n") : null;
  let next: string;
  if (existing === null) {
    next = `#!/bin/sh\n\n${block}\n`;
    console.log(`Hook: created ${hookPath}`);
  } else if (existing.includes(BEGIN) && existing.includes(END)) {
    const start = existing.indexOf(BEGIN);
    const end = existing.indexOf(END) + END.length;
    next = existing.slice(0, start) + block + existing.slice(end);
    console.log(next === existing ? `Hook: already installed in ${hookPath}` : `Hook: updated block in ${hookPath}`);
  } else {
    next = `${existing.replace(/\n*$/, "\n")}\n${block}\n`;
    console.log(`Hook: appended to existing ${hookPath}`);
    if (/^\s*exit\b/m.test(existing)) {
      console.warn("Warning: the existing hook contains `exit`; if it runs before the pixel-commit block, recording is skipped.");
    }
  }
  // LF only: Git for Windows runs hooks with sh, which chokes on CRLF.
  writeFileSync(hookPath, next);
  chmodSync(hookPath, 0o755);

  // 3. Output folder must not be committed.
  try {
    git(["check-ignore", "-q", `${STATE_DIR}/videos`], root);
  } catch {
    console.warn(`Warning: ${STATE_DIR}/ is not gitignored. Add it to .gitignore.`);
  }
  return 0;
}

/**
 * Absolute paths to node and this CLI, so commits from GUIs without node on
 * PATH still work. Runs in a subshell and never exits the hook itself.
 */
export function hookBlock(): string {
  const node = toShPath(process.execPath);
  const cli = toShPath(realpathSync(process.argv[1]));
  return `${BEGIN}
# Installed by \`pixel-commit init\`. Records this commit in the background.
# Safe to delete this block. Re-running init updates it in place.
(
  [ "$PIXEL_COMMIT_RUNNING" = "1" ] && exit 0
  pc_logs="$(git rev-parse --show-toplevel)/${STATE_DIR}/logs"
  mkdir -p "$pc_logs"
  pc_node='${node}'
  pc_cli='${cli}'
  if [ -f "$pc_node" ] && [ -f "$pc_cli" ]; then
    "$pc_node" "$pc_cli" record "$(git rev-parse HEAD)" --detach >>"$pc_logs/hook.log" 2>&1
  elif command -v pixel-commit >/dev/null 2>&1; then
    pixel-commit record "$(git rev-parse HEAD)" --detach >>"$pc_logs/hook.log" 2>&1
  else
    echo "$(date) pixel-commit not found (node: $pc_node, cli: $pc_cli); not recording" >>"$pc_logs/hook.log"
  fi
) || true
${END}`;
}

function toShPath(p: string): string {
  return p.replaceAll("\\", "/").replaceAll("'", "'\\''");
}

/** Inside the working tree but not inside .git. */
function isTrackedLocation(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const relToGit = path.relative(commonGitDir(root), dir);
  return relToGit.startsWith("..") || path.isAbsolute(relToGit);
}
