// Runs the user's coding-agent CLI headless: prompt on stdin, answer on
// stdout. The generator only returns text; pixel-commit validates, saves and
// runs the specs itself.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GeneratorConfig } from "./config.js";
import { killTree } from "./process.js";

export interface GeneratorAnswer {
  /** Parsed JSON answer (not yet validated). */
  answer: unknown;
  durationMs: number;
  /** The CLI's own cost estimate, if it reports one (claude does). Not a bill. */
  costUsd: number | null;
}

export class GeneratorError extends Error {}
/** The CLI ran but its answer was not JSON. Worth a retry. */
export class GeneratorOutputError extends GeneratorError {}

/** Split a command string into argv, honoring "double" and 'single' quotes. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new GeneratorError(`generator.command has an unclosed ${quote} quote`);
  if (started) args.push(current);
  return args;
}

export function isClaude(program: string): boolean {
  return path.basename(program).toLowerCase().replace(/\.(exe|cmd)$/, "") === "claude";
}

/**
 * Flags pixel-commit adds when the generator is Claude Code (checked against
 * the CLI reference, v2.1.296): no built-in tools, no MCP tools, no user
 * customizations (CLAUDE.md, hooks, plugins, skills), our own system prompt
 * instead of the coding-agent one, JSON output validated against a schema,
 * nothing saved to disk, and a spend cap.
 */
function claudeFlags(systemPromptFile: string, schema: object, maxBudgetUsd: number): string[] {
  return [
    "--output-format", "json",
    "--tools", "",
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
    "--safe-mode",
    "--no-session-persistence",
    "--system-prompt-file", systemPromptFile,
    "--json-schema", JSON.stringify(schema),
    "--max-budget-usd", String(maxBudgetUsd),
  ];
}

export async function runGenerator(
  config: GeneratorConfig,
  systemPrompt: string,
  prompt: string,
  schema: object,
): Promise<GeneratorAnswer> {
  const argv = splitCommand(config.command);
  if (argv.length === 0) throw new GeneratorError("generator.command is empty");
  const [program, ...args] = argv;
  const claude = isClaude(program);

  // Empty scratch folder as cwd: not the repo, not the worktree.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "pixel-commit-gen-"));
  try {
    const systemFile = path.join(scratch, "system-prompt.txt");
    writeFileSync(systemFile, systemPrompt);
    if (claude) args.push(...claudeFlags(systemFile, schema, config.maxBudgetUsd));
    // Other CLIs get the system prompt in front of the prompt (and its path in
    // the environment); locking down their tools is the user's job.
    const input = claude ? prompt : `${systemPrompt}\n\n${prompt}`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PIXEL_COMMIT_RUNNING: "1",
      PIXEL_COMMIT_SYSTEM_PROMPT_FILE: systemFile,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const started = Date.now();
    const { code, stdout, stderr } = await spawnWithInput(program, args, input, scratch, env, config.timeoutMs);
    const durationMs = Date.now() - started;

    if (claude) return { ...parseClaude(stdout, stderr, code), durationMs };
    if (code !== 0) throw new GeneratorError(`generator exited with code ${code}: ${tail(stderr || stdout)}`);
    return { answer: extractJson(stdout), durationMs, costUsd: null };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseClaude(stdout: string, stderr: string, code: number | null): Omit<GeneratorAnswer, "durationMs"> {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new GeneratorError(`claude exited with code ${code} and no JSON output: ${tail(stderr || stdout)}`);
  }
  const costUsd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
  if (envelope.is_error === true || envelope.subtype !== "success") {
    throw new GeneratorError(`claude reported ${String(envelope.subtype)}: ${tail(String(envelope.result ?? ""))}`);
  }
  // With --json-schema the validated object is in structured_output.
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return { answer: envelope.structured_output, costUsd };
  }
  return { answer: extractJson(String(envelope.result ?? "")), costUsd };
}

/** Whole text as JSON, else a ```json fence, else first "{" to last "}". */
export function extractJson(text: string): unknown {
  const attempts = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) attempts.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next
    }
  }
  throw new GeneratorOutputError(`generator output is not JSON: ${tail(text)}`);
}

function spawnWithInput(
  program: string,
  args: string[],
  input: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // own process group, for killTree on POSIX
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new GeneratorError(
          err.code === "ENOENT"
            ? `generator "${program}" not found on PATH (generator.command in pixel-commit.config.json)`
            : `could not start generator: ${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new GeneratorError(`generator timed out after ${timeoutMs / 1000}s`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {
      // The CLI may exit before reading all input; its exit code says why.
    });
    child.stdin.end(input, "utf8");
  });
}

function tail(text: string, max = 500): string {
  const t = text.trim();
  return t.length > max ? `...${t.slice(-max)}` : t;
}
