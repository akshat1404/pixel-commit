# pixel-commit

After every git commit, pixel-commit runs Cypress tests for your app in a
headless browser, records a video, and saves it under
`.pixel-commit/videos/<sha>/` together with a `result.json`. It runs in the
background, so `git commit` doesn't wait. Free, local, no upload.

**Status:** milestone 2. Recording on commit works; the specs are the ones
already in your repo (matching `specPattern`). AI-written specs come next.

## Setup

Requires Node 22 or 24 and git.

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
  videos/<sha>/<spec>.mp4     one video per spec
  videos/<sha>/result.json    status, timings, per-test results, errors
  logs/<sha>.log              full log of that recording
  logs/hook.log               one line per commit from the hook
```

`status` is `passed`, `failed` (a test failed), `error` (could not run: dev
server didn't start, Cypress couldn't start, ...) or `skipped` (no specs).

## Commands

```sh
node packages/cli/dist/index.js record [sha]   # record a commit now (default HEAD)
node packages/cli/dist/index.js list           # recorded commits: sha, status, time, message
node packages/cli/dist/index.js init           # (re)install config + hook
```

## Config

`pixel-commit.config.json` in the repo root (all keys optional):

```json
{
  "projectDir": "playground",
  "startCommand": "node ../node_modules/vite/bin/vite.js --port {port} --strictPort",
  "baseUrl": "http://localhost:{port}",
  "specPattern": "cypress/e2e/**/*.cy.ts",
  "keepLast": 30
}
```

- `projectDir`: folder with the app and its `cypress.config`.
- `startCommand`: starts your dev server, run in `projectDir`. `{port}` is
  replaced with a free port (each recording gets its own).
- `baseUrl`: what to wait for, and Cypress's `baseUrl`.
- `specPattern`: which specs to run, relative to `projectDir`.
- `keepLast`: how many recorded commits to keep.

## How it works

The hook starts a detached background process and returns. That process
waits its turn (one recording at a time per repo), checks the commit out
into a temporary `git worktree` (so uncommitted edits never end up in the
video), starts your dev server there, runs Cypress with video, copies the
videos out, and removes the worktree. Many quick commits queue up and are
recorded one after another.

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
