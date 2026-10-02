#!/usr/bin/env node
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const USAGE = `pixel-commit ${pkg.version}

Usage:
  pixel-commit --version   Print version
  pixel-commit --help      Show this help`;

const [arg] = process.argv.slice(2);

switch (arg) {
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;
  case undefined:
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command: ${arg}\n\n${USAGE}`);
    process.exitCode = 1;
}
