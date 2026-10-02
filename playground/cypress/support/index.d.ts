declare namespace Cypress {
  interface CaptionOptions {
    /** Milliseconds to wait after showing the caption so viewers can read it. Default 1500. */
    pause?: number;
  }

  interface Chainable {
    /**
     * Show a caption banner at the bottom of the page. It appears in the
     * recorded video, replaces any previous caption, and survives navigation
     * and re-renders.
     * @example cy.caption("Filter the list to March")
     */
    caption(text: string, options?: CaptionOptions): Chainable<void>;
  }
}
