// Fake generator for testing the repair loop without an AI.
// Config: "generator": { "command": "node <path>/fake-generator.mjs" }
// First call: a spec with a selector that does not exist (fails).
// Repair call (prompt contains a "failing-spec" data block): a correct spec.

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const isRepair = /BEGIN failing-spec/.test(prompt);
const target = isRepair ? '[data-testid=event-count]' : '[data-testid=event-total-does-not-exist]';

const code = `export {};

describe("Events list", () => {
  it("shows how many events are listed", () => {
    cy.visit("/");
    cy.caption(${JSON.stringify(isRepair ? "Fixed selector: the event count" : "Broken selector on purpose")});
    cy.get(${JSON.stringify(target)}, { timeout: 3000 }).scrollIntoView().should("contain.text", "Showing 8 of 8 events");
    cy.wait(600);
  });
});
`;

process.stdout.write(
  JSON.stringify({
    kind: "video",
    reason: isRepair ? "Fake generator: repaired spec." : "Fake generator: first spec with a broken selector.",
    specs: [{ name: "fake-repair.cy.ts", code }],
  }),
);
