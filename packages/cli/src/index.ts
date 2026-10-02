#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { init } from "./init.js";
import { launchDetached } from "./launch.js";
import { list } from "./list.js";
import { record } from "./recorder.js";
import { runSession } from "./session.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const USAGE = `pixel-commit ${pkg.version}

Usage:
  pixel-commit init                 Create pixel-commit.config.json and install the post-commit hook
  pixel-commit record [sha]         Record a commit (default HEAD) into .pixel-commit/videos/<sha>/
  pixel-commit record <sha> --detach   Same, in the background (used by the hook)
  pixel-commit list                 Show recorded commits
  pixel-commit --version            Print version
  pixel-commit --help               Show this help`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return init();
    case "record": {
      const detach = rest.includes("--detach");
      const rev = rest.find((a) => !a.startsWith("--")) ?? "HEAD";
      return detach ? launchDetached(rev) : record(rev);
    }
    case "list":
      return list();
    case "__session": // internal: child process of `record`
      await runSession();
      return 0;
    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;
    case undefined:
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`pixel-commit: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
