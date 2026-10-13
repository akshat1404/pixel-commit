# pixel-commit

A free, local developer tool. After every git commit it automatically:

1. asks an AI to generate a few happy-path Cypress tests for what that commit changed,
2. runs them in a headless browser with video recording,
3. saves the video plus a small result file, keyed by the commit's SHA.

The developer never writes Cypress tests.

## Status

- **Milestone 1 (done):** a Cypress-recorded video is pleasant to watch.
  Playground app, `cy.caption()`, one hand-written spec, `npm run record:demo`.
- **Milestone 2 (done):** recording is attached to git commits. `pixel-commit
  init | record | list`, post-commit hook, worktree isolation, lock/queue,
  retention.
- **Milestone 3 (built, verification with the real `claude` CLI pending):**
  AI-backed `SpecProvider` (`ai-provider.ts`). Per commit the AI picks the
  output kind (`video` | `screenshot` | `none`) and writes 1-3 happy-path
  specs; strict validation (string deny-list + TypeScript AST allow-list);
  repair loop (max 2 repairs); FIFO queue; superseded commits.
  `PatternSpecProvider` stays available via `"specProvider": "pattern"`.
  Plan and design decisions: [docs/MILESTONE-3-PLAN.md](docs/MILESTONE-3-PLAN.md).
  Don't build past milestone 3.

## v1 design

- **Trigger:** a git `post-commit` hook starts `pixel-commit record` as a
  detached background process, so `git commit` is never slowed or blocked.
  Env var `PIXEL_COMMIT_RUNNING=1` prevents infinite hook loops. *(built)*
- **Isolation:** recording happens in a temporary `git worktree` at the commit,
  so the video shows committed code, not uncommitted edits. Output goes to the
  MAIN repo at `.pixel-commit/videos/<sha>/` (gitignored). *(built)*
- **AI:** the user's own coding-agent CLI, run headless, configured in
  `pixel-commit.config.json` (`generator.command`, default
  `claude -p --model sonnet`). The AI only returns text (JSON); pixel-commit
  validates, saves and runs the specs itself. *(built)*
- **Scope:** happy path only, at most 3 tests per commit. No browser-visible
  change = kind `none`, status `skipped` with the AI's reason. *(built)*
- **Readability:** `cy.caption(text)` draws a banner into the page so it shows
  in the recording (and in `cy.screenshot()` output). *(built)*
- **Retention:** keep only the newest N video folders (config: `keepLast`). *(built)*
- **Local only.** No upload, no approval gate, no pull-request integration.

## Layout

```
pixel-commit.config.json   recorder config (read from the MAIN repo root only)
packages/cli/src/
  index.ts           command routing (init, record, list, --version, __session)
  config.ts          load/validate pixel-commit.config.json, defaults
  spec-provider.ts   SpecProvider interface (SpecPlan, repair, report) + PatternSpecProvider
  ai-provider.ts     AiSpecProvider: prompts, commit data, answer validation, repair
  generator.ts       runs generator.command (stdin prompt, stdout JSON), claude lockdown flags
  claude-finder.ts   finds claude: PATH, else newest editor extension (resolved every call)
  spec-validation.ts deny-list + TypeScript AST allow-list for generated specs
  recorder.ts        record flow, repair loop, artifacts, result.json, retention
  session.ts         child process: dev server + cypress.run() (several runs), IPC
  queue.ts           .pixel-commit/queue/ (FIFO order), superseded detection
  lock.ts            .pixel-commit/lock (one recording at a time, FIFO via queue, stale detection)
  worktree.ts        create/remove worktrees, junction handling, stale cleanup
  launch.ts          `record <sha> --detach` (what the hook calls)
  init.ts            config + hook install; hookBlock()
  list.ts            `list` table
  video.ts           ffmpeg finder, loading-screen trim, duration (also used by record-demo)
  git.ts, process.ts helpers (git with clean env, killTree, freePort, waitForUrl)
packages/cli/test/
  spec-validation.test.mjs   node:test unit tests (validator, delimiter, JSON extraction)
  claude-finder.test.mjs     finder tests (fake extension folders)
  fixtures/fake-generator.mjs  generator stand-in: broken spec, then fixed on repair
playground/          React + Vite demo app used as test target
  src/components/    SignupForm, DateFilterList, DelayedSection
  cypress/support/   e2e.ts = cy.caption() + repaint ticker; index.d.ts = typings
  cypress/e2e/       specs (date-filter.cy.ts is the hand-written reference)
  scripts/record-demo.ts   npm run record:demo (milestone 1 manual recording)
.pixel-commit/       output, gitignored: videos/<sha>/, videos/manual/, logs/, queue/, lock
~/.pixel-commit/worktrees/   temporary recording worktrees (outside the repo)
```

## Commands

- `npm install` (root; npm workspaces), then `npm run build -w pixel-commit`
  (the hook runs `packages/cli/dist/index.js`; dist is gitignored).
- `npm test -w pixel-commit` - unit tests (build first; they import `dist/`).
- `node packages/cli/dist/index.js init` - create config if missing, install hook.
- `node packages/cli/dist/index.js record [sha]` - record in the foreground.
- `node packages/cli/dist/index.js list` - recorded commits (status, kind, time).
- `npm run dev` - playground on http://localhost:5173
- `npm run typecheck` - all workspaces
- `npm run record:demo` - milestone 1: date-filter spec to `.pixel-commit/videos/manual/`

## Recorder

Flow of `record <sha>` (`recorder.ts`):

1. Clean env (strip git's hook vars + `ELECTRON_RUN_AS_NODE`), set
   `PIXEL_COMMIT_RUNNING=1` for everything spawned (dev server, Cypress,
   generator).
2. Register in `.pixel-commit/queue/`; wait until first in the queue and the
   lock is free (FIFO), take `.pixel-commit/lock`, leave the queue.
3. Load config from the **main** repo (missing file = defaults).
4. **Superseded?** If a still-queued newer commit descends from this one
   (`git merge-base --is-ancestor`), or this commit is on no branch
   (`git branch --contains` empty) and not an ancestor of HEAD (amend,
   rebase): status `superseded`, no worktree, no generator call.
5. Remove stale worktrees; `git worktree add --detach
   ~/.pixel-commit/worktrees/pixel-commit-wt-<sha12>-<pid> <sha>`; junction
   `node_modules` -> main repo's; real empty `<projectDir>/node_modules`.
6. `SpecProvider.getSpecs()` -> `{ kind, reason, specs }`. Kind `none` =
   status `skipped`, no dev server.
7. Spawn the **session** (`__session`, detached, IPC: `start` / `run` /
   `stop`): starts `startCommand` on a free port (`{port}`), waits for
   `baseUrl`, then runs `cypress.run()` with `runnerUi: false`,
   `config: {baseUrl, video}` (video off for kind `screenshot`), specs
   comma-joined. Same dev server for every run.
8. After each run, copy + trim videos and copy screenshots into
   `.pixel-commit/videos/<sha>/` (Cypress wipes its folders on the next run).
9. Repair loop: for each failing spec, `provider.repair()` rewrites it, and
   only repaired specs re-run. Max 2 repairs (3 attempts) per spec.
10. `finally`: provider report into result.json, unlink junction,
    `git worktree remove --force --force`, rm leftovers, `git worktree prune`;
    write `result.json`; retention; release lock.

`result.json`: `status` (`passed` | `failed` = tests failed | `error` = could
not run | `skipped` = kind none | `superseded`), `sha`, `message`, `kind`,
`reason`, `queuedAt`, `startedAt`, `finishedAt`, `durationMs`,
`specProvider`, `generator` (`command`, `calls`, `durationMs`, `costUsd`),
`diffTruncated`, `supersededBy`, `specs[]` (`spec`, `status`, `attempts`,
`passes`, `failures`, `video`, `screenshots[]` relative paths, `tests[]` with
`title`, `state`, `error`), `error`. Generated specs: `specs/<name>.cy.ts`
(last version) and `specs/<name>.attempt-<n>.cy.ts` (earlier ones).
Re-recording a SHA replaces its folder. Exit code 0 for
passed/skipped/superseded, 1 otherwise.

Hook (`init.ts`): block between `# >>> pixel-commit >>>` / `# <<< pixel-commit <<<`,
appended to an existing `post-commit` or a new `#!/bin/sh` file (LF only).
Re-running init replaces the block in place. Runs in a subshell, never
`exit`s the hook, `|| true`. Contains absolute paths to `node` and the CLI
(GUI commits may lack node on PATH); falls back to `pixel-commit` on PATH;
otherwise logs "not found" to `.pixel-commit/logs/hook.log` and exits 0. If
the hooks dir (`git rev-parse --git-path hooks`, honors `core.hooksPath`) is
inside the working tree (e.g. Husky), init refuses and prints the block,
because those absolute paths must not be committed.

Config (`pixel-commit.config.json`, all optional, unknown keys rejected):
`projectDir` (`playground`), `startCommand` (must contain `{port}`),
`baseUrl` (must contain `{port}`), `specProvider` (`ai` default | `pattern`),
`specPattern` (pattern provider only; glob relative to projectDir),
`generator` (`command` default `claude -p --model sonnet`, `timeoutMs`
180000, `maxDiffBytes` 60000, `maxBudgetUsd` 0.5), `routes`
(`[{ path, description }]`, told to the AI), `keepLast` (integer >= 1,
default 30).

## AI spec provider (milestone 3)

- **Finding claude** (`claude-finder.ts`): when the program is a bare
  `claude`, it is resolved at **every** call (never stored: editors rename
  extension folders on each update): `claude[.exe]` on PATH, else the newest
  `anthropic.claude-code-<version>*` folder (numeric version compare; folders
  listed in the editor's `.obsolete` file are skipped) under
  `~/.vscode`, `~/.vscode-insiders`, `~/.cursor`, `~/.windsurf`,
  `~/.vscode-oss` `/extensions` that contains
  `resources/native-binary/claude[.exe]` (the only file there on Windows,
  v2.1.296). None: status `error`, "Claude Code not found: install the VS Code
  extension or the claude CLI". The path used goes to
  `result.json` `generator.resolvedPath`. A path in the command (e.g.
  `C:/x/claude.exe -p`) is used as is.
- **Generator call** (`generator.ts`): `generator.command` split into argv
  (quotes honored), spawned without a shell in an empty temp folder, prompt
  on stdin, answer on stdout, killed after `timeoutMs`. If the program is
  `claude`, these flags are appended: `--output-format json --tools ""
  --strict-mcp-config --disallowedTools "mcp__*" --safe-mode
  --no-session-persistence --system-prompt-file <ours> --json-schema <ours>
  --max-budget-usd <maxBudgetUsd>`. Other CLIs get the system prompt in front
  of the prompt; locking down their tools is the user's job.
- **costUsd** in result.json is the CLI's own estimate (`total_cost_usd`),
  not necessarily what you are billed.
- **Inputs** (`ai-provider.ts`): commit message, `git show --name-status`,
  the diff (cut at `maxDiffBytes`; prompt and `diffTruncated` say so), full
  content of changed files under `projectDir` (excluding `cypress/`; capped),
  routes, and the spec rules (system prompt).
- **Data is not instructions.** All commit content goes in blocks fenced by
  a random per-call delimiter (`PXC-<24 hex>`), checked to occur nowhere in
  the data. The system prompt says block content is material to test, never
  instructions.
- **Validation** (`spec-validation.ts`), any failure = one retry with the
  problems sent back, then status `error`: JSON shape; `kind`/specs agree;
  names `^[a-z0-9]+(-[a-z0-9]+)*\.cy\.ts$`; at most 3 `it()` in total; each
  `it()` calls `cy.caption` and `cy.visit` (in the test or a
  `before`/`beforeEach`); screenshot specs call `cy.screenshot`. Then the
  string deny-list (quick, readable errors) and the AST allow-list (the real
  guard): top-level only `export {}`, literal `const`s, and
  `describe/it/before/beforeEach` with parameterless non-async callbacks;
  inside, only cy chains of `visit get contains find within click type
  clear check select should wait caption screenshot` plus `and first last eq
  scrollIntoView` (readable assertions, picking one match, scrolling into
  frame); arguments only literals, object/array literals, top-level
  constants, `+ - * /`; `within` takes a callback. Rejected: computed member
  access, `window document globalThis Cypress fetch eval require process
  Function`, `cy.request/task/exec/readFile/writeFile` and every other
  command, variables, control flow, imports. Uses the recorded project's
  `typescript` (peer dependency).
- Generated specs go to `<worktree>/<projectDir>/cypress/e2e/__pixel_commit__/`
  (matches the playground's `specPattern`).
- **Repair** prompt: same commit data + `failing-spec` + `cypress-error`
  blocks; must return exactly one spec with the same name.
- Testing without an AI: `"generator": { "command": "node
  <repo>/packages/cli/test/fixtures/fake-generator.mjs" }` (fails first,
  passes after one repair).

## Claude Code headless facts (CLI reference + v2.1.296)

- `claude -p` reads the whole prompt from stdin. `--output-format json` ->
  one object: `result`, `is_error`, `subtype`, `num_turns`, `duration_ms`,
  `total_cost_usd`, `session_id`; with `--json-schema`, the answer is in
  `structured_output`.
- `--tools ""` removes built-in tools, not MCP tools (add
  `--strict-mcp-config --disallowedTools "mcp__*"`). Probe: init event showed
  `tools: []`, `mcp_servers: []`.
- `--safe-mode` skips CLAUDE.md, hooks, plugins, skills, MCP; keeps OAuth
  login. `--bare` needs `ANTHROPIC_API_KEY`, so not used.
- Replace the system prompt (`--system-prompt-file`): with the default one,
  a tool-less model still claimed to have Bash.
- Users need no separate install: the VS Code extension ships the same CLI
  (`resources/native-binary/claude.exe`), found by `claude-finder.ts`. It
  uses the extension's sign-in.
- `--json-schema` works together with `--tools ""` (answer arrives in
  `structured_output`; logs say `answer from structured_output`). If a
  CLI version returns only text, the same validation runs on JSON parsed from
  `result`.

### Known issues / limits

- **Recordings can pile up.** Each commit queues one background recorder;
  with AI generation a recording takes ~1-3 minutes. Superseded commits
  (a newer queued commit builds on them, or amended/rebased away) are
  skipped without generation, so a burst of commits on one branch costs
  about two recordings, but commits on different branches all record, one
  at a time. Each waiting recorder is a node process polling once a second.
- The worktree uses the main repo's installed `node_modules`; a commit that
  changes dependencies is recorded with the currently installed ones.
- Each spec video ends with ~0.5s of Cypress's "Default blank page" (Cypress
  clears the page at the end of a spec even with `testIsolation: false`).
- Retention removes folders without `result.json` (killed runs) but keeps
  their logs; `hook.log` is never rotated.
- If the session process itself is force-killed (not the recorder), the dev
  server can still be orphaned (see libuv job objects below).
- Commits made on a detached HEAD are recorded only while HEAD still contains
  them (the "no branch" superseded rule also checks HEAD).
- `cy.screenshot({ capture: "fullPage" })` on a page taller than the
  viewport: how the fixed caption appears in the stitched image is untested
  (the playground fits in 720px; viewport and fullPage were identical).

## Conventions

- TypeScript everywhere, strict. Node scripts are `.ts` run by plain `node`
  (Node 22.18+/24 type stripping), so use only erasable syntax there (no enums,
  no namespaces, no parameter properties) and explicit `.ts` import extensions.
  `packages/cli/src/video.ts` has no relative imports because `record-demo.ts`
  imports it that way.
- Dependencies: free/open source, latest stable, each justifiable in one
  sentence. Prefer Node built-ins (`fs.globSync`, `fetch`, `child_process`).
  The CLI has no runtime deps; Cypress is a `peerDependency`, resolved from the
  recorded project with `createRequire(<projectDir>/package.json)`.
- Playground: plain CSS, no UI library. Interactive elements get `data-testid`.
- Specs: happy path only. Each test must `cy.visit()` (in `it()` or
  `beforeEach`), because test isolation is off. Each `it()` starts with `cy.caption(...)`.
  `cy.caption` already pauses 1.5s (option `{ pause }`); use 500-800ms
  `cy.wait` between actions (spec uses `BEAT = 650`). Too slow is easier to fix
  than too fast. Specs and support files `export {}` so they are modules.
- Video filenames: keep Cypress defaults (`<spec>.mp4`); the SHA folder carries
  identity.
- Don't trust memory for Cypress, git or Claude Code behavior; check docs.cypress.io /
  git-scm.com / code.claude.com.
- Don't commit in this repo to test the hook: use a throwaway clone (see
  "Testing the hook").

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
  out right after the run.
- Module API: `cypress.run({ project, spec, browser, headless, runnerUi, quiet, config })`.
  `spec` is documented as a string; several specs are comma-joined (verified:
  2 specs -> 2 runs -> 2 videos). Result: `startedTestsAt`, `endedTestsAt`,
  `totalDuration`, `totalPassed`, `totalFailed`, ..., `runs[]` with `spec`
  (`relative`), `stats` (`passes`, `failures`, ...), `tests[]` (`title[]`,
  `state`, `displayError`), `video` (absolute path or null). If Cypress could
  not start: `{ status: "failed", failures, message }` instead (narrow with
  `"status" in result`).
- Cypress 16 requires Node 22.x, 24.x or >=26.
- By default the video is the whole runner (command log left, app scaled to
  ~62%). We pass `runnerUi: false` (CLI: `--no-runner-ui`; default `true`
  unless Test Replay is on) so the video is only the app, 1280x720 at 100%.
- With `runnerUi: false`, capture only gets frames when the page repaints
  (seen in Electron, Chrome and Edge): static stretches came out blank or
  frozen and steps went missing. Fix: the repaint ticker. Electron is the
  recording browser.
- Cypress bundles ffmpeg at
  `<cypress cache>/<version>/**/@ffmpeg-installer/<platform>-<arch>/ffmpeg[.exe]`
  (cache dir from `cypress cache path`). Used for trim/duration/frames.

## git facts (checked against git-scm.com docs, git 2.29 here)

- `post-commit` takes no args and cannot affect the commit outcome.
- Hooks run at the worktree root with `GIT_DIR`, `GIT_INDEX_FILE`, ... exported;
  git commands aimed elsewhere must clear them (`git rev-parse --local-env-vars`).
- `git rev-parse --git-path hooks` honors `core.hooksPath` (returns it relative
  to the top level if it was relative).
- `git worktree remove` refuses unclean worktrees without `--force`, locked ones
  without `--force --force`; `git worktree prune` drops registrations whose
  folders are gone.

## Known gotchas

- **`ELECTRON_RUN_AS_NODE=1`** is set by VS Code and inherited by its terminals
  and git hooks. It makes Cypress's Electron binary act as Node:
  `bad option: --smoke-test`. Deleted from the env before calling Cypress.
- **Vite exits when stdin ends** (`setupSIGTERMListener` in vite's
  `chunks/node.js`, skipped only when `CI=true`). `cypress.run()` pipes the
  parent's stdin into Cypress, which ends it. Always run the dev server as a
  child with `stdin: "pipe"` kept open.
- `cypress/bin/cypress` is not in the package's `exports`; resolve via
  `cypress/package.json`'s `bin` field.
- **Junction safety (Windows).** Worktree `node_modules` is a directory
  junction to the main repo's (symlinks need admin/Developer Mode; junctions
  don't; `lstat().isSymbolicLink()` is true for junctions; `unlinkSync`
  removes only the link). ALWAYS unlink it before `git worktree remove` or
  `rmSync` of a worktree, including stale-worktree cleanup. Verified after
  every test (and after killing a recording mid-run): main node_modules
  unchanged.
- **Vite writes `.vite-temp` / `.vite` to the nearest `node_modules`.** In a
  worktree that is the junction -> main repo. The recorder creates a real empty
  `<projectDir>/node_modules` in the worktree so those writes stay inside it.
- **libuv job objects (Windows).** Node puts non-detached children in a
  kill-on-close job object, but processes started by `cmd.exe` (shell: true)
  silently break away. Killing a parent therefore kills its node children
  instantly (no cleanup code runs) while the shell-started dev server is
  orphaned. Hence the session is spawned `detached`, and on IPC `disconnect`
  it runs `taskkill /T /F` on itself. Verified: kill recorder mid-run -> 0
  node/Cypress processes left after 8s.
- **Worktrees under %TEMP% are slow.** Cypress took ~85-97s to start in a
  worktree under `%TEMP%` vs ~24s under the home folder (same files, same
  junction; likely antivirus). Hence `~/.pixel-commit/worktrees/`.
- **Hook timing.** `git commit` took 1.0-1.6s warm (3.3s first, cold) with the
  hook vs ~0.3-0.6s without; the difference is one Node startup for the
  `--detach` launcher. It never waits for the recording (~60-110s).

## Known constraints to revisit

- **TypeScript pinned to `^6`.** TS 7 (Go-native compiler) is latest on npm,
  but Cypress compiles TS specs through its bundled webpack/ts-loader using the
  project's `typescript` JS API, which TS 7 may not provide. Revisit when
  Cypress documents TS 7 support. TS 6 note: default `types` is `[]`, so every
  tsconfig lists its `types` explicitly.
- Each raw video opens on ~1-23s of static Cypress placeholder while the spec
  loads. Trimmed (`video.ts`): first ffmpeg scene change
  (`select='gt(scene,0.1)'`) = app appears; cut there, re-encode with libx264
  (Cypress writes a keyframe only every 10s, so `-c copy` can't cut
  accurately). Skips trimming if no change is found or less than 2s would remain (no fixed
  cap: one slow run had a 22.9s blank start).
- `testIsolation` is `false` in `cypress.config.ts`. With `true`, Cypress
  navigates to `about:blank` before each test, and its "Default blank page"
  showed for ~1s between tests in the video. The support `beforeEach` does
  the rest of isolation itself (`cy.clearAllCookies/LocalStorage/
  SessionStorage`, all domains; verified). Consequence: the page is NOT reset,
  so every test (or its `beforeEach`) must `cy.visit()`. IndexedDB was never
  cleared by Cypress either way.
- Bottom caption can still cover content near the bottom of a 720px viewport.

## Testing the hook

Commits trigger the hook, so test in a throwaway clone, never in this repo:

```sh
git clone . ~/pc-sandbox
cmd //c mklink //J "C:\Users\<you>\pc-sandbox\node_modules" "<this repo>\node_modules"   # Windows
cd ~/pc-sandbox && node <this repo>/packages/cli/dist/index.js init
```

Delete it later by removing the `node_modules` junction FIRST (`cmd //c rmdir
...\node_modules`), then the folder.

## Checking a video

You can't watch it; build a 1fps contact sheet and look for blank/frozen
stretches and caption/step order (ffmpeg path: see Cypress facts):
`ffmpeg -i <video> -vf "fps=1,scale=320:-1,tile=5x5" -frames:v 1 sheet.png`
