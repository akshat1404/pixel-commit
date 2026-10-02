# pixel-commit

After every git commit, pixel-commit asks your own AI coding CLI to write a few
happy-path Cypress tests for what changed, runs them headless with video, and
saves the video under `.pixel-commit/videos/<sha>/`. Free, local, no upload.

**Status:** milestone 1, an experiment to check that Cypress videos are
pleasant to watch. The commit hook and AI generation are not built yet.

## Try it

Requires Node 22 or 24.

```sh
npm install
npm run record:demo
```

This starts the playground app, runs `playground/cypress/e2e/date-filter.cy.ts`
headless with video, and copies the video to
`.pixel-commit/videos/manual/date-filter.cy.ts.mp4`. It prints the path, size
and duration.

Other commands:

```sh
npm run dev                          # playground on http://localhost:5173
npm run typecheck
npm run cy:open -w playground        # Cypress UI
npm run build -w pixel-commit && node packages/cli/dist/index.js --version
```

## Layout

- `packages/cli` - the `pixel-commit` CLI (skeleton: `--version` only)
- `playground` - React + Vite demo app with a signup form, a date-filterable
  list and a delayed-load section, plus Cypress and the `cy.caption()` command

## cy.caption

```ts
cy.caption("Pick a start date: March 1, 2026"); // shows banner, waits 1.5s
cy.caption("Next step", { pause: 0 });          // no wait
```

Draws a caption banner at the bottom of the page so it appears in the video.
A new caption replaces the old one. It survives page navigation and re-renders.

