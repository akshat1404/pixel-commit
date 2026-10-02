# pixel-commit

A free, local developer tool. After every git commit it automatically:

1. asks an AI to generate a few happy-path Cypress tests for what that commit changed,
2. runs them in a headless browser with video recording,
3. saves the video plus a small result file, keyed by the commit's SHA.

The developer never writes Cypress tests.

## Status

**Milestone 1 (done):** prove a Cypress-recorded video is pleasant to watch.
Playground app, `cy.caption()`, one hand-written spec, `npm run record:demo`,
CLI skeleton with `--version` only. Nothing below "v1 design" is built yet
unless this section says so. Don't build ahead of the current milestone.

## v1 design (target, not yet built)

- **Trigger:** a git `post-commit` hook starts `pixel-commit record` as a
  detached background process, so `git commit` is never slowed or blocked.
  Env var `PIXEL_COMMIT_RUNNING=1` prevents infinite hook loops.
- **Isolation:** recording happens in a temporary `git worktree` at the commit,
  so the video shows committed code, not uncommitted edits. Output goes to the
  MAIN repo at `.pixel-commit/videos/<sha>/` (gitignored).
- **AI:** the user's own coding-agent CLI, run headless, configured in
  `pixel-commit.config.json`, e.g. `{"generator": {"command": "claude -p"}}`.
  The AI only returns text; pixel-commit saves and runs the spec itself.
- **Scope:** happy path only, at most 3 tests per commit. If the commit has no
  browser-visible change, skip and record that in `result.json`.
- **Readability:** `cy.caption(text)` draws a banner into the page so it shows
  in the recording.
- **Retention:** keep only the newest N video folders (config: `keepLast`).
- **Local only.** No upload, no approval gate, no pull-request integration.

## Layout

```
packages/cli/          pixel-commit CLI (bin: pixel-commit). Skeleton only.
playground/            React + Vite demo app (port 5173) used as test target
  src/components/      SignupForm, DateFilterList, DelayedSection
  cypress/support/     e2e.ts = cy.caption(); index.d.ts = its typings
  cypress/e2e/         specs (date-filter.cy.ts is the hand-written reference)
  scripts/record-demo.ts   npm run record:demo
.pixel-commit/         output (gitignored)
```

## Commands

- `npm install` (root; npm workspaces)
- `npm run dev` - playground dev server on http://localhost:5173
- `npm run typecheck` - all workspaces
- `npm run record:demo` - run date-filter spec headless with video, copy to
  `.pixel-commit/videos/manual/`, print path, size (MB), duration
- `npm run build -w pixel-commit && node packages/cli/dist/index.js --version`

## Conventions

- TypeScript everywhere, strict. Node scripts are `.ts` run by plain `node`
  (Node 22.18+/24 type stripping), so use only erasable syntax there (no enums,
  no namespaces, no parameter properties) and explicit `.ts` import extensions.
- Dependencies: free/open source, latest stable, each justifiable in one
  sentence. Prefer Node built-ins (`fs.globSync`, `fetch`, `child_process`).
- Playground: plain CSS, no UI library. Interactive elements get `data-testid`.
- Specs: happy path only. Each test must `cy.visit()` (in `it()` or
  `beforeEach`), because test isolation is off. Each `it()` starts with `cy.caption(...)`.
  `cy.caption` already pauses 1.5s (option `{ pause }`); use 500-800ms
  `cy.wait` between actions (spec uses `BEAT = 650`). Too slow is easier to fix
  than too fast. Specs and support files `export {}` so they are modules.
- Video filenames: keep Cypress defaults (`<spec>.mp4`); the SHA folder carries
  identity.
- Don't trust memory for Cypress behavior; check docs.cypress.io.

## cy.caption

`playground/cypress/support/e2e.ts`. Bottom-center fixed banner
(`#pixel-commit-caption`), dark semi-transparent background, white 28px text,
`pointer-events: none` so it never blocks Cypress actions. One caption at a
time. Re-injected on `window:load` (navigation) and by a `MutationObserver`
if removed. Reset in `beforeEach`. Not drawn on `about:blank` (where Cypress
parks the app frame between tests). Verified: survives `cy.reload`,
`cy.visit`, element removal, `body.innerHTML` wipe.

Same file injects `#pixel-commit-ticker` into every app page: a fixed 1px
element whose background alpha flips each `requestAnimationFrame`, kept alive
by the same observer. Needed for `runnerUi: false` videos (see below). Don't
remove it without re-checking a frame contact sheet.

## Cypress facts (checked against docs, Cypress 16.1.1)

- `video` default `false`. Must be enabled.
- `videoCompression` default `false` (`0`/`false` = off, else CRF 1-51; `true` = 32).
  We keep it off for sharp caption text.
- `trashAssetsBeforeRuns` default `true`: wipes the whole `videosFolder`,
  `screenshotsFolder`, `downloadsFolder` before each `cypress run`. Copy videos
  out before the next run.
- Module API: `cypress.run({ project, spec, browser, headless, config, ... })`.
  Result has `runs[].video`, `totalPassed`, `totalFailed`, `totalDuration`; if
  Cypress could not start, result is `{ status: "failed", message, ... }`
  instead (narrow with `"status" in result`).
- Cypress 16 requires Node 22.x, 24.x or >=26.
- By default the video is the whole runner (command log left, app scaled to
  ~62%). We pass `runnerUi: false` to `cypress.run()` (CLI: `--no-runner-ui`;
  default `true` unless Test Replay is on) so the video is only the app,
  1280x720 at 100%, 25fps, H.264.
- With `runnerUi: false`, capture only gets frames when the page repaints
  (seen in Electron, Chrome and Edge): static stretches came out blank or
  frozen and steps went missing. Chrome/Edge also recorded at odd sizes
  (1264x624). Fix: the support file injects a 1px repaint ticker (see
  cy.caption below). Electron is the recording browser.
- Cypress bundles ffmpeg at
  `<cypress cache>/<version>/**/@ffmpeg-installer/<platform>-<arch>/ffmpeg[.exe]`
  (cache dir from `cypress cache path`). Used for duration/frames; no
  ffmpeg dependency needed.

## Known gotchas (must handle in the real `record` command)

- **`ELECTRON_RUN_AS_NODE=1`** is set by VS Code and inherited by its terminals
  and probably by hooks fired from its git UI. It makes Cypress's Electron
  binary act as Node: `bad option: --smoke-test`. Delete it from the env before
  calling Cypress.
- **Vite exits when stdin ends** (`setupSIGTERMListener` in vite's
  `chunks/node.js`, skipped only when `CI=true`). `cypress.run()` pipes the
  parent's stdin into Cypress, which ends it, so an in-process Vite server
  silently `process.exit(0)`s mid-run. Run the dev server as a child process
  with a `stdin: "pipe"` kept open. A detached hook process will also have no
  stdin, so this applies there too.
- `cypress/bin/cypress` is not in the package's `exports`; resolve via
  `cypress/package.json`'s `bin` field.

## Known constraints to revisit

- **TypeScript pinned to `^6`.** TS 7 (Go-native compiler) is latest on npm,
  but Cypress compiles TS specs through its bundled webpack/ts-loader using the
  project's `typescript` JS API, which TS 7 may not provide. Revisit when
  Cypress documents TS 7 support. TS 6 note: default `types` is `[]`, so every
  tsconfig lists its `types` explicitly.
- Each raw video opens on ~3-4s of static Cypress placeholder while the spec
  loads. `record-demo.ts` trims it: first ffmpeg scene change
  (`select='gt(scene,0.1)'`) = app appears; cut there, re-encode with libx264
  (Cypress writes a keyframe only every 10s, so `-c copy` can't cut
  accurately). Skips trimming if no change is found or it is past 15s. The raw
  video in `cypress/videos/` is overwritten with the trimmed one too.
- `testIsolation` is `false` in `cypress.config.ts`. With `true`, Cypress
  navigates to `about:blank` before each test, and its "Default blank page"
  showed for ~1s between tests in the video. The support `beforeEach` does
  the rest of isolation itself (`cy.clearAllCookies/LocalStorage/
  SessionStorage`, all domains; verified). Consequence: the page is NOT reset,
  so every test (or its `beforeEach`) must `cy.visit()`. IndexedDB was never
  cleared by Cypress either way. (Per-frame entropy was tried for cutting the
  blank page out of the video instead; it doesn't separate blank from app
  frames.)
- Bottom caption can still cover content near the bottom of a 720px viewport.

## Checking a video

You can't watch it; build a 1fps contact sheet and look for blank/frozen
stretches and caption/step order (ffmpeg path: see Cypress facts):
`ffmpeg -i <video> -vf "fps=1,scale=320:-1,tile=5x5" -frames:v 1 sheet.png`
