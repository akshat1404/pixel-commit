// cy.caption(text): draws a fixed banner into the app page so it shows up in
// the recorded video. One caption at a time; a new call replaces the old one.
// The banner is re-injected after page loads (navigation) and if anything
// removes it from the DOM (re-renders that touch <body>).
//
// Also injects a repaint ticker into every app page. Videos are recorded
// without the Cypress runner UI (runnerUi: false), and then the capture only
// receives frames when the page repaints: a static page produced long blank or
// frozen stretches with steps missing. A 1px, near-invisible element that
// changes every animation frame keeps frames flowing at a steady rate.

const CAPTION_ID = "pixel-commit-caption";
const TICKER_ID = "pixel-commit-ticker";
const DEFAULT_PAUSE_MS = 1500;

let currentCaption: string | null = null;
const observed = new WeakSet<Document>();

function isAppPage(doc: Document) {
  // Cypress parks the app frame on about:blank between tests.
  return Boolean(doc.body) && doc.location?.protocol !== "about:";
}

function renderCaption(doc: Document) {
  if (!isAppPage(doc)) return;
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
}

function renderTicker(doc: Document) {
  if (!isAppPage(doc) || doc.getElementById(TICKER_ID)) return;
  const win = doc.defaultView;
  if (!win) return;
  const tick = doc.createElement("div");
  tick.id = TICKER_ID;
  tick.setAttribute("aria-hidden", "true");
  Object.assign(tick.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1px",
    height: "1px",
    pointerEvents: "none",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);
  doc.body.appendChild(tick);
  let odd = false;
  const step = () => {
    if (!tick.isConnected) return; // renderTicker starts a new loop when re-added
    odd = !odd;
    tick.style.background = odd ? "rgba(0, 0, 0, 0.01)" : "rgba(0, 0, 0, 0.02)";
    win.requestAnimationFrame(step);
  };
  win.requestAnimationFrame(step);
}

function render(doc: Document) {
  renderTicker(doc);
  renderCaption(doc);
  watch(doc);
}

function watch(doc: Document) {
  if (!isAppPage(doc) || observed.has(doc)) return;
  observed.add(doc);
  const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
  new Observer(() => {
    const captionMissing = currentCaption !== null && !doc.getElementById(CAPTION_ID);
    if (captionMissing || !doc.getElementById(TICKER_ID)) render(doc);
  }).observe(doc.documentElement, { childList: true, subtree: true });
}

// Fires for every page load in the app under test, including navigations.
Cypress.on("window:load", (win) => render(win.document));

beforeEach(() => {
  // Don't let one test's caption leak into the next.
  currentCaption = null;
  cy.document({ log: false }).then((doc) => render(doc));
  // testIsolation is off (see cypress.config.ts), so do its state reset here,
  // minus the about:blank navigation.
  cy.clearAllCookies({ log: false });
  cy.clearAllLocalStorage({ log: false });
  cy.clearAllSessionStorage({ log: false });
});

Cypress.Commands.add("caption", (text: string, options: Cypress.CaptionOptions = {}) => {
  const pause = options.pause ?? DEFAULT_PAUSE_MS;
  Cypress.log({ name: "caption", message: text });
  currentCaption = text;
  cy.document({ log: false }).then((doc) => render(doc));
  if (pause > 0) cy.wait(pause, { log: false });
});

export {};
