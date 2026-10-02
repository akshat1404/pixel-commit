import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "pixel-commit.config.json";

export interface Config {
  /** Folder (relative to repo root) holding the app and its cypress.config. */
  projectDir: string;
  /** Starts the dev server, run in projectDir. Must contain {port}. */
  startCommand: string;
  /** URL to wait for and Cypress baseUrl. Must contain {port}. */
  baseUrl: string;
  /** Glob, relative to projectDir, of specs to run. */
  specPattern: string;
  /** How many recorded commits to keep. */
  keepLast: number;
}

export const DEFAULT_CONFIG: Config = {
  projectDir: "playground",
  startCommand: "node ../node_modules/vite/bin/vite.js --port {port} --strictPort",
  baseUrl: "http://localhost:{port}",
  specPattern: "cypress/e2e/**/*.cy.ts",
  keepLast: 30,
};

export class ConfigError extends Error {}

/** Always read from the main repo root, never from a recording worktree. */
export function loadConfig(root: string): { config: Config; file: string | null } {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return { config: { ...DEFAULT_CONFIG }, file: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE}: not valid JSON (${(err as Error).message})`);
  }
  return { config: validateConfig(raw), file };
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${CONFIG_FILE}: must be a JSON object`);
  }
  const input = raw as Record<string, unknown>;
  const problems: string[] = [];
  const known = Object.keys(DEFAULT_CONFIG);
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) problems.push(`unknown key "${key}" (allowed: ${known.join(", ")})`);
  }

  const config = { ...DEFAULT_CONFIG };
  for (const key of ["projectDir", "startCommand", "baseUrl", "specPattern"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`"${key}" must be a non-empty string (got ${JSON.stringify(value)})`);
    } else {
      config[key] = value;
    }
  }
  if ("keepLast" in input) {
    const value = input.keepLast;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      problems.push(`"keepLast" must be an integer >= 1 (got ${JSON.stringify(value)})`);
    } else {
      config.keepLast = value;
    }
  }
  for (const key of ["startCommand", "baseUrl"] as const) {
    if (!config[key].includes("{port}")) {
      problems.push(`"${key}" must contain {port}; pixel-commit picks a free port per run`);
    }
  }
  if (path.isAbsolute(config.projectDir) || config.projectDir.split(/[\\/]/).includes("..")) {
    problems.push(`"projectDir" must be a path inside the repo (got "${config.projectDir}")`);
  }

  if (problems.length > 0) {
    throw new ConfigError(`${CONFIG_FILE} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return config;
}

export function withPort(template: string, port: number): string {
  return template.replaceAll("{port}", String(port));
}
