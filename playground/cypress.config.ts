import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:5173",
    supportFile: "cypress/support/e2e.ts",
    specPattern: "cypress/e2e/**/*.cy.ts",
  },
  viewportWidth: 1280,
  viewportHeight: 720,
  // Off by default in Cypress; recording is the point of this project.
  video: true,
  // false = no re-encode. Keeps caption text sharp; revisit if files get large.
  videoCompression: false,
  // Default true: wipes videosFolder before each `cypress run`. Fine, because
  // record:demo copies the video out to .pixel-commit/ afterwards.
  trashAssetsBeforeRuns: true,
});
