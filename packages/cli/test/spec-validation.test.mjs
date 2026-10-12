// Run: npm run build -w pixel-commit && npm test -w pixel-commit
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pickDelimiter } from "../dist/ai-provider.js";
import { extractJson, splitCommand } from "../dist/generator.js";
import { validateSpec } from "../dist/spec-validation.js";

const ts = createRequire(import.meta.url)("typescript");
const check = (code) => validateSpec(ts, "x.cy.ts", code);
const errors = (code) => check(code).errors.join("\n");

const GOOD = `export {};

const BEAT = 600;

describe("Events date filter", () => {
  beforeEach(() => {
    cy.visit("/");
  });

  it("narrows the list to a date range", () => {
    cy.caption("Pick a start date");
    cy.get("[data-testid=filter-from]").type("2026-03-01");
    cy.wait(BEAT);
    cy.caption("Only later events remain");
    cy.contains("li", "Beta launch").should("be.visible").and("contain.text", "Mar");
    cy.get("li").first().scrollIntoView();
    cy.contains("section", "Events").within(() => {
      cy.contains("button", "Clear").click();
    });
  });
});
`;

test("accepts a normal happy-path spec", () => {
  const res = check(GOOD);
  assert.deepEqual(res.errors, []);
  assert.equal(res.tests, 1);
  assert.equal(res.screenshots, false);
});

test("accepts a screenshot spec with a concise beforeEach", () => {
  const res = check(`export {};
beforeEach(() => cy.visit("/"));
it("shows the badge", () => {
  cy.caption("Look at the new badge");
  cy.contains("Recorded on every commit").scrollIntoView().should("be.visible");
  cy.screenshot("badge", { capture: "viewport" });
});`);
  assert.deepEqual(res.errors, []);
  assert.equal(res.screenshots, true);
});

for (const [label, line, expected] of [
  ["cy.exec", `cy.exec("rm -rf /");`, /cy\.exec is not allowed/],
  ["cy.task", `cy.task("x");`, /cy\.task is not allowed/],
  ["cy.request", `cy.request("/api");`, /cy\.request is not allowed/],
  ["cy.readFile", `cy.readFile("a.txt");`, /cy\.readFile is not allowed/],
  ["cy.writeFile", `cy.writeFile("a.txt", "x");`, /cy\.writeFile is not allowed/],
  ["then callback", `cy.get("a").then(() => {});`, /\.then|cy\.then/],
  ["window global", `cy.get(window.location.href);`, /`window` is not allowed/],
  ["document global", `cy.get(document.title);`, /`document` is not allowed/],
  ["globalThis", `cy.get(globalThis.x);`, /`globalThis` is not allowed/],
  ["Cypress global", `cy.get(Cypress.env("x"));`, /`Cypress` is not allowed/],
  ["fetch", `cy.get(fetch("/x"));`, /`fetch` is not allowed|fetch\(\)/],
  ["computed member", `cy["exec"]("ls");`, /computed member access/],
  ["computed on chain", `cy.get("a")["click"]();`, /computed member access/],
  ["local variable", `const a = "x"; cy.get(a);`, /a variable declaration is not allowed/],
  ["if statement", `if (true) { cy.get("a"); }`, /an if statement is not allowed/],
  ["non-cy root", `foo.click();`, /must start at `cy`/],
  ["unknown identifier", `cy.get(secret);`, /unknown identifier `secret`/],
  ["eval", `cy.get(eval("1"));`, /eval/],
  ["require", `cy.get(require("fs"));`, /require/],
]) {
  test(`rejects ${label}`, () => {
    const code = `export {};\nit("t", () => {\n  cy.visit("/");\n  cy.caption("c");\n  ${line}\n});\n`;
    assert.match(errors(code), expected);
  });
}

test("rejects imports and it.only", () => {
  assert.match(errors(`import fs from "fs";\nit("t", () => { cy.visit("/"); cy.caption("c"); });`), /import/);
  assert.match(errors(`it.only("t", () => { cy.visit("/"); cy.caption("c"); });`), /cy command chains|must start at `cy`|inside it/);
});

test("requires caption and visit in each test", () => {
  assert.match(errors(`it("t", () => { cy.visit("/"); });`), /must call cy\.caption/);
  assert.match(errors(`it("t", () => { cy.caption("c"); });`), /must call cy\.visit/);
});

test("rejects async callbacks and syntax errors", () => {
  assert.match(errors(`it("t", async () => { cy.visit("/"); cy.caption("c"); });`), /not async/);
  assert.match(errors(`it("t", () => { cy.visit("/" ; });`), /syntax error/);
});

test("delimiter never occurs in the data", () => {
  const d = pickDelimiter(["PXC-abc", "some diff"]);
  assert.match(d, /^PXC-[0-9a-f]{24}$/);
  assert.ok(!"PXC-abc some diff".includes(d));
});

test("splitCommand honors quotes", () => {
  assert.deepEqual(splitCommand(`claude -p --model sonnet`), ["claude", "-p", "--model", "sonnet"]);
  assert.deepEqual(splitCommand(`node "C:/a b/gen.mjs" ''`), ["node", "C:/a b/gen.mjs", ""]);
});

test("extractJson finds the object in fenced or chatty output", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('ok {"a":3} done'), { a: 3 });
  assert.throws(() => extractJson("no json"), /not JSON/);
});
