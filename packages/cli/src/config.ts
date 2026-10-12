import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "pixel-commit.config.json";

export interface GeneratorConfig {
  /**
   * CLI that turns a prompt (stdin) into the JSON answer (stdout). When the
   * program is `claude`, pixel-commit adds the flags that remove all tools.
   */
  command: string;
  /** Kill the generator after this long. */
  timeoutMs: number;
  /** Cap on the diff sent to the generator; longer diffs are cut and flagged. */
  maxDiffBytes: number;
  /** Passed as --max-budget-usd to `claude` (per call; the CLI's own estimate). */
  maxBudgetUsd: number;
}

export interface Route {
  path: string;
  description: string;
}

export interface Config {
  /** Folder (relative to repo root) holding the app and its cypress.config. */
  projectDir: string;
  /** Starts the dev server, run in projectDir. Must contain {port}. */
  startCommand: string;
  /** URL to wait for and Cypress baseUrl. Must contain {port}. */
  baseUrl: string;
  /** "ai": generate specs per commit. "pattern": run committed specs (debugging). */
  specProvider: "ai" | "pattern";
  /** Glob, relative to projectDir, of specs to run with specProvider "pattern". */
  specPattern: string;
  generator: GeneratorConfig;
  /** Pages of the app, described for the generator. */
  routes: Route[];
  /** How many recorded commits to keep. */
  keepLast: number;
}

export const DEFAULT_CONFIG: Config = {
  projectDir: "playground",
  startCommand: "node ../node_modules/vite/bin/vite.js --port {port} --strictPort",
  baseUrl: "http://localhost:{port}",
  specProvider: "ai",
  specPattern: "cypress/e2e/**/*.cy.ts",
  generator: {
    command: "claude -p --model sonnet",
    timeoutMs: 180_000,
    maxDiffBytes: 60_000,
    maxBudgetUsd: 0.5,
  },
  routes: [
    {
      path: "/",
      description:
        "Single page with a header and three sections: a Sign up form, an Events list with a date-range filter, and a Stats section that loads data after a short delay.",
    },
  ],
  keepLast: 30,
};

export class ConfigError extends Error {}

/** Always read from the main repo root, never from a recording worktree. */
export function loadConfig(root: string): { config: Config; file: string | null } {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return { config: structuredClone(DEFAULT_CONFIG), file: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE}: not valid JSON (${(err as Error).message})`);
  }
  return { config: validateConfig(raw), file };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function validateConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigError(`${CONFIG_FILE}: must be a JSON object`);
  const input = raw;
  const problems: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);

  const known = Object.keys(DEFAULT_CONFIG);
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) problems.push(`unknown key "${key}" (allowed: ${known.join(", ")})`);
  }

  for (const key of ["projectDir", "startCommand", "baseUrl", "specPattern"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`"${key}" must be a non-empty string (got ${JSON.stringify(value)})`);
    } else {
      config[key] = value;
    }
  }
  if ("specProvider" in input) {
    if (input.specProvider === "ai" || input.specProvider === "pattern") config.specProvider = input.specProvider;
    else problems.push(`"specProvider" must be "ai" or "pattern" (got ${JSON.stringify(input.specProvider)})`);
  }
  if ("keepLast" in input) {
    const value = input.keepLast;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      problems.push(`"keepLast" must be an integer >= 1 (got ${JSON.stringify(value)})`);
    } else {
      config.keepLast = value;
    }
  }

  if ("generator" in input) {
    const gen = input.generator;
    if (!isObject(gen)) {
      problems.push(`"generator" must be an object`);
    } else {
      const genKnown = Object.keys(DEFAULT_CONFIG.generator);
      for (const key of Object.keys(gen)) {
        if (!genKnown.includes(key)) problems.push(`unknown key "generator.${key}" (allowed: ${genKnown.join(", ")})`);
      }
      if ("command" in gen) {
        if (typeof gen.command !== "string" || gen.command.trim() === "") {
          problems.push(`"generator.command" must be a non-empty string`);
        } else {
          config.generator.command = gen.command;
        }
      }
      for (const key of ["timeoutMs", "maxDiffBytes"] as const) {
        if (!(key in gen)) continue;
        const value = gen[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1000) {
          problems.push(`"generator.${key}" must be an integer >= 1000 (got ${JSON.stringify(value)})`);
        } else {
          config.generator[key] = value;
        }
      }
      if ("maxBudgetUsd" in gen) {
        const value = gen.maxBudgetUsd;
        if (typeof value !== "number" || !(value > 0)) {
          problems.push(`"generator.maxBudgetUsd" must be a number > 0 (got ${JSON.stringify(value)})`);
        } else {
          config.generator.maxBudgetUsd = value;
        }
      }
    }
  }

  if ("routes" in input) {
    const routes = input.routes;
    if (!Array.isArray(routes) || routes.length === 0) {
      problems.push(`"routes" must be a non-empty array of { "path", "description" }`);
    } else {
      const parsed: Route[] = [];
      routes.forEach((r, i) => {
        if (!isObject(r) || typeof r.path !== "string" || !r.path.startsWith("/") || typeof r.description !== "string") {
          problems.push(`"routes[${i}]" must be { "path": "/...", "description": "..." }`);
        } else {
          parsed.push({ path: r.path, description: r.description });
        }
      });
      config.routes = parsed;
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
