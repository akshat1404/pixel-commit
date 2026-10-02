import { globSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export interface SpecContext {
  sha: string;
  /** Root of the temporary worktree checked out at `sha`. */
  worktreeDir: string;
  /** The Cypress project inside the worktree (worktreeDir + config.projectDir). */
  projectDir: string;
  config: Config;
}

/**
 * Decides which spec files to run for a commit. The recorder only knows this
 * interface. Milestone 3 swaps in an AI-backed provider that writes specs
 * into ctx.projectDir and returns their paths.
 */
export interface SpecProvider {
  readonly name: string;
  /** Absolute paths of spec files. Empty array = nothing to record. */
  getSpecs(ctx: SpecContext): Promise<string[]>;
}

/** Milestone 2: the specs already committed that match config.specPattern. */
export class PatternSpecProvider implements SpecProvider {
  readonly name = "pattern";

  async getSpecs(ctx: SpecContext): Promise<string[]> {
    return globSync(ctx.config.specPattern, { cwd: ctx.projectDir })
      .map((rel) => path.join(ctx.projectDir, rel))
      .sort();
  }
}
