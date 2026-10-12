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

/** What a commit gets: a video, a screenshot, or nothing. */
export type OutputKind = "video" | "screenshot" | "none";

export interface SpecPlan {
  kind: OutputKind;
  /** One sentence: why this kind (shown in result.json). */
  reason: string;
  /** Absolute paths of spec files inside the worktree. Empty for kind "none". */
  specs: string[];
}

/**
 * Decides what to run for a commit. The recorder only knows this interface.
 */
export interface SpecProvider {
  readonly name: string;
  getSpecs(ctx: SpecContext): Promise<SpecPlan>;
  /**
   * Optional: rewrite a spec that failed. Overwrites the file at `spec` and
   * returns true, or returns false to give up.
   */
  repair?(ctx: SpecContext, spec: string, error: string): Promise<boolean>;
  /** Extra fields merged into result.json (generator stats, ...). */
  report?(): Record<string, unknown>;
}

/** specProvider "pattern": the committed specs matching config.specPattern (debugging). */
export class PatternSpecProvider implements SpecProvider {
  readonly name = "pattern";

  async getSpecs(ctx: SpecContext): Promise<SpecPlan> {
    const specs = globSync(ctx.config.specPattern, { cwd: ctx.projectDir })
      .map((rel) => path.join(ctx.projectDir, rel))
      .sort();
    return {
      kind: specs.length > 0 ? "video" : "none",
      reason: specs.length > 0 ? `Committed specs matching ${ctx.config.specPattern}` : `No specs match ${ctx.config.specPattern}`,
      specs,
    };
  }
}
