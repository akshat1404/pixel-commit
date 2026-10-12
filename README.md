# pixel-commit

After every git commit, pixel-commit asks your own AI coding CLI (Claude Code
by default) what that commit changed in the browser, has it write a few
happy-path Cypress tests, runs them headless, and saves a video or a
screenshot under `.pixel-commit/videos/<sha>/` with a `result.json`. It runs
in the background, so `git commit` doesn't wait. You never write the tests.
Local, no upload.

**Status:** milestone 3. Per commit the AI decides:

- **video**: the change is interactive or happens over time (clicks, typing,
  filtering, loading). 1-3 happy-path tests, recorded.
- **screenshot**: the change is static and visual (a badge, a color, a label).
  One spec that takes a `.png`.
- **none**: nothing visible changed (docs, config, refactors). Nothing runs;
  the reason is saved.

## Setup

Requires Node 22 or 24, git, and the Claude Code CLI on your PATH
(`claude install`; you must be signed in).

```sh
npm install
npm run build -w pixel-commit
node packages/cli/dist/index.js init
```

`init` creates `pixel-commit.config.json` (if missing) and adds a block to
`.git/hooks/post-commit` (appending to an existing hook; safe to re-run). It
refuses if your hooks folder is committed (e.g. Husky) and prints the block
to add yourself instead.

From then on, every commit records in the background:

```
.pixel-commit/
  videos/<sha>/<spec>.mp4          one video per spec (kind video)
  videos/<sha>/screenshots/*.png   kind screenshot
  videos/<sha>/specs/*.cy.ts       the specs that ran (earlier repair attempts too)
  videos/<sha>/result.json         status, kind, reason, timings, per-test results
  logs/<sha>.log                   full log of that recording
  logs/hook.log                    one line per commit from the hook
```

`status` is `passed`, `failed` (a test failed), `error` (could not run: the
generator failed or gave invalid output twice, dev server didn't start, ...),
`skipped` (kind `none`) or `superseded` (a newer commit on the same branch was
already waiting, or the commit was amended or rebased away; nothing ran).

## Commands

```sh
node packages/cli/dist/index.js record [sha]   # record a commit now (default HEAD)
node packages/cli/dist/index.js list           # recorded commits: sha, status, kind, time, message
node packages/cli/dist/index.js init           # (re)install config + hook
npm test -w pixel-commit                       # unit tests (after building)
```

## Config

`pixel-commit.config.json` in the repo root (all keys optional):

```json
{
  "projectDir": "playground",
  "startCommand": "node ../node_modules/vite/bin/vite.js --port {port} --strictPort",
  "baseUrl": "http://localhost:{port}",
  "specProvider": "ai",
  "generator": {
    "command": "claude -p --model sonnet",
    "timeoutMs": 180000,
    "maxDiffBytes": 60000,
    "maxBudgetUsd": 0.5
  },
  "routes": [{ "path": "/", "description": "Sign up form, events list with date filter, stats" }],
  "keepLast": 30
}
```

- `projectDir`: folder with the app and its `cypress.config`.
- `startCommand`: starts your dev server, run in `projectDir`. `{port}` is
  replaced with a free port (each recording gets its own).
- `baseUrl`: what to wait for, and Cypress's `baseUrl`.
- `specProvider`: `ai`, or `pattern` to run your committed specs matching
  `specPattern` instead (useful for debugging).
- `generator.command`: the CLI that writes the tests. It gets the prompt on
  stdin and must print JSON. For `claude`, pixel-commit adds flags that turn
  off all its tools, so it can only answer with text.
- `generator.maxBudgetUsd`: spend cap per call, passed to `claude`. The cost
  in `result.json` is the CLI's own estimate, not necessarily your bill.
- `generator.maxDiffBytes`: longer diffs are cut (and `result.json` says so).
- `routes`: your app's pages, described for the AI.
- `keepLast`: how many recorded commits to keep.

## How it works

The hook starts a detached background process and returns. That process
waits its turn (one recording at a time per repo, first come first served),
skips itself if a newer commit on the same branch is already waiting, and
checks the commit out into a temporary `git worktree` (so uncommitted edits
never end up in the video). It sends the commit's diff and changed files to
the AI as data, never as instructions, and checks every generated spec
against a strict allow-list of Cypress commands before running it (no
`cy.exec`, no file or network access). It starts your dev server, runs the
specs, asks the AI to fix a failing spec up to twice, copies the videos or
screenshots out, and removes the worktree.

## Playground

`playground/` is a small React + Vite app (signup form, date-filtered list,
delayed section) used as the test target, with Cypress and a `cy.caption()`
command:

```ts
cy.caption("Pick a start date: March 1, 2026"); // banner in the video, waits 1.5s
cy.caption("Next step", { pause: 0 });          // no wait
```

```sh
npm run dev           # playground on http://localhost:5173
npm run record:demo   # one manual recording to .pixel-commit/videos/manual/
npm run typecheck
```
