// cy.caption(text): draws a fixed banner into the app page so it shows up in
// the recorded video. One caption at a time; a new call replaces the old one.
// The banner is re-injected after page loads (navigation) and if anything
// removes it from the DOM (re-renders that touch <body>).

const CAPTION_ID = "pixel-commit-caption";
const DEFAULT_PAUSE_MS = 1500;

let currentCaption: string | null = null;
const observed = new WeakSet<Document>();

function renderCaption(doc: Document) {
  if (!doc.body) return;
  let el = doc.getElementById(CAPTION_ID);
  if (currentCaption === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement("div");
    el.id = CAPTION_ID;
    el.setAttribute("role", "status");
    Object.assign(el.style, {
      position: "fixed",
      left: "50%",
      bottom: "28px",
      transform: "translateX(-50%)",
      maxWidth: "88vw",
      width: "max-content",
      padding: "14px 28px",
      borderRadius: "12px",
      background: "rgba(0, 0, 0, 0.78)",
      color: "#ffffff",
      font: '600 28px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      textAlign: "center",
      boxShadow: "0 4px 18px rgba(0, 0, 0, 0.35)",
      zIndex: "2147483647",
      // Never intercept clicks, so Cypress actionability checks are unaffected.
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    doc.body.appendChild(el);
  }
  if (el.textContent !== currentCaption) el.textContent = currentCaption;
  watch(doc);
}

function watch(doc: Document) {
  if (observed.has(doc)) return;
  observed.add(doc);
  const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
  new Observer(() => {
    if (currentCaption !== null && !doc.getElementById(CAPTION_ID)) renderCaption(doc);
  }).observe(doc.documentElement, { childList: true, subtree: true });
}

// Fires for every page load in the app under test, including navigations.
Cypress.on("window:load", (win) => renderCaption(win.document));

// Don't let one test's caption leak into the next.
beforeEach(() => {
  currentCaption = null;
});

Cypress.Commands.add("caption", (text: string, options: Cypress.CaptionOptions = {}) => {
  const pause = options.pause ?? DEFAULT_PAUSE_MS;
  Cypress.log({ name: "caption", message: text });
  currentCaption = text;
  cy.document({ log: false }).then((doc) => renderCaption(doc));
  if (pause > 0) cy.wait(pause, { log: false });
});

export {};
