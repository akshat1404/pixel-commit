// Checks generated Cypress specs before they run. Two layers:
// 1. A string deny-list: quick, catches obvious misuse with readable errors.
// 2. An AST allow-list (TypeScript compiler API): only a small, known-safe
//    subset of syntax and Cypress commands is accepted. This is what actually
//    stops a spec from running commands or touching files: anything not
//    explicitly allowed is rejected.

import type * as TS from "typescript";

export type TypeScriptApi = typeof TS;

/** Allowed top-level (and nested) test structure calls. */
const STRUCTURE_CALLS = new Set(["describe", "it", "before", "beforeEach"]);

/**
 * Allowed cy commands. The first group was set by the project owner; the
 * second group is needed for readable happy-path specs:
 *   and           alias of should, for chained assertions
 *   first/last/eq pick one element when a selector matches several
 *   scrollIntoView bring the element into the video frame
 */
const CY_COMMANDS = new Set([
  "visit", "get", "contains", "find", "within", "click", "type", "clear", "check",
  "select", "should", "wait", "caption", "screenshot",
  "and", "first", "last", "eq", "scrollIntoView",
]);

/** Commands named in errors, so the generator learns why on retry. */
const FORBIDDEN_COMMANDS = new Set(["request", "task", "exec", "readFile", "writeFile", "window", "document", "intercept", "then", "invoke", "its", "wrap", "origin", "session", "fixture", "selectFile"]);

const FORBIDDEN_GLOBALS = new Set([
  "window", "document", "globalThis", "Cypress", "fetch", "eval", "require", "process",
  "Function", "XMLHttpRequest", "localStorage", "sessionStorage", "import",
]);

const DENY_STRINGS: Array<[RegExp, string]> = [
  [/\bcy\s*\.\s*(exec|task|request|readFile|writeFile|selectFile)\b/, "uses a forbidden cy command"],
  [/\brequire\s*\(/, "uses require()"],
  [/\bimport\s*(\(|[\w{*])/, "uses import"],
  [/\bprocess\s*\./, "uses process"],
  [/\beval\s*\(/, "uses eval()"],
  [/\bFunction\s*\(/, "uses Function()"],
  [/child_process/, "mentions child_process"],
  [/\bfetch\s*\(/, "uses fetch()"],
];

export interface SpecCheck {
  errors: string[];
  /** Number of it() blocks. */
  tests: number;
  /** True if the spec calls cy.screenshot(). */
  screenshots: boolean;
}

export function validateSpec(ts: TypeScriptApi, name: string, code: string): SpecCheck {
  const errors: string[] = [];
  for (const [pattern, message] of DENY_STRINGS) {
    if (pattern.test(code)) errors.push(`${name}: ${message}`);
  }

  const { diagnostics } = ts.transpileModule(code, {
    fileName: name,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  if (diagnostics && diagnostics.length > 0) {
    const text = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ");
    return { errors: [...errors, `${name}: syntax error: ${text}`], tests: 0, screenshots: false };
  }

  const checker = new SpecChecker(ts, name);
  checker.checkFile(ts.createSourceFile(name, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS));
  return { errors: [...errors, ...checker.errors], tests: checker.tests, screenshots: checker.screenshots };
}

type Scope = "top" | "describe" | "test" | "hook";

class SpecChecker {
  errors: string[] = [];
  tests = 0;
  screenshots = false;
  private constants = new Set<string>();
  /** Expression bodies of concise arrows (`() => cy.visit("/")`), checked like statements. */
  private concise = new WeakSet<TS.Node>();

  constructor(
    private ts: TypeScriptApi,
    private name: string,
  ) {}

  /** Readable node kind (SyntaxKind[] can return enum aliases like FirstStatement). */
  private kindName(node: TS.Node): string {
    const ts = this.ts;
    if (ts.isVariableStatement(node)) return "a variable declaration";
    if (ts.isIfStatement(node)) return "an if statement";
    if (ts.isFunctionDeclaration(node)) return "a function declaration";
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "a function";
    if (ts.isCallExpression(node)) return "a function call";
    if (ts.isPropertyAccessExpression(node)) return "property access";
    if (ts.isIterationStatement(node, false)) return "a loop";
    return ts.SyntaxKind[node.kind];
  }

  private fail(node: TS.Node, message: string): void {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    this.errors.push(`${this.name}:${line + 1}: ${message}`);
  }

  checkFile(sf: TS.SourceFile): void {
    const ts = this.ts;
    this.scanForbidden(sf);
    // Constants first, so they may be used anywhere in the file.
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) this.checkConstant(stmt);
    }
    const visitHook = this.scopeHasVisitHook(sf.statements);
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) continue;
      if (ts.isExportDeclaration(stmt)) {
        const empty =
          !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause) && stmt.exportClause.elements.length === 0;
        if (!empty) this.fail(stmt, "only `export {};` is allowed as an export");
        continue;
      }
      this.checkStatement(stmt, "top", visitHook);
    }
  }

  /** Forbidden globals and computed member access anywhere in the file. */
  private scanForbidden(node: TS.Node): void {
    const ts = this.ts;
    const visit = (n: TS.Node): void => {
      if (ts.isElementAccessExpression(n)) this.fail(n, "computed member access (x[y]) is not allowed");
      if (ts.isIdentifier(n) && FORBIDDEN_GLOBALS.has(n.text)) {
        const parent = n.parent;
        const isMemberName = parent && ts.isPropertyAccessExpression(parent) && parent.name === n;
        const isKey = parent && ts.isPropertyAssignment(parent) && parent.name === n;
        if (!isMemberName && !isKey) this.fail(n, `\`${n.text}\` is not allowed`);
      }
      if (n.kind === ts.SyntaxKind.ImportKeyword) this.fail(n, "import is not allowed");
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /** Top-level `const NAME = <number or string literal>;` (e.g. a pacing constant). */
  private checkConstant(stmt: TS.VariableStatement): void {
    const ts = this.ts;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) {
      this.fail(stmt, "only `const` declarations are allowed");
      return;
    }
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      const literal = init && (ts.isNumericLiteral(init) || ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init));
      if (!ts.isIdentifier(decl.name) || !literal || decl.type) {
        this.fail(decl, "top-level constants must be `const NAME = <number or string literal>`");
        continue;
      }
      this.constants.add(decl.name.text);
    }
  }

  private checkStatement(stmt: TS.Node, scope: Scope, visitHook: boolean): void {
    const ts = this.ts;
    let expr: TS.Expression;
    if (this.concise.has(stmt)) expr = stmt as TS.Expression;
    else if (ts.isExpressionStatement(stmt)) expr = stmt.expression;
    else {
      this.fail(stmt, `${this.kindName(stmt)} is not allowed here (only describe/it/before/beforeEach and cy commands)`);
      return;
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && STRUCTURE_CALLS.has(expr.expression.text)) {
      this.checkStructureCall(expr, expr.expression.text, scope, visitHook);
      return;
    }
    if (scope === "top" || scope === "describe") {
      this.fail(stmt, "cy commands must be inside it(), before() or beforeEach()");
      return;
    }
    this.checkCyChain(expr);
  }

  private checkStructureCall(call: TS.CallExpression, fn: string, scope: Scope, visitHook: boolean): void {
    const ts = this.ts;
    if (scope === "test" || scope === "hook") {
      this.fail(call, `${fn}() is not allowed inside a test or hook`);
      return;
    }
    const needsTitle = fn === "describe" || fn === "it";
    const args = call.arguments;
    const expected = needsTitle ? 2 : 1;
    if (args.length !== expected) {
      this.fail(call, `${fn}() takes ${needsTitle ? "a title and a callback" : "one callback"}`);
      return;
    }
    if (needsTitle && !ts.isStringLiteral(args[0]) && !ts.isNoSubstitutionTemplateLiteral(args[0])) {
      this.fail(args[0], `${fn}() title must be a string literal`);
    }
    const body = this.callbackBody(args[expected - 1], fn);
    if (!body) return;

    if (fn === "describe") {
      const inner = visitHook || this.scopeHasVisitHook(body);
      for (const s of body) this.checkStatement(s, "describe", inner);
      return;
    }
    const kind: Scope = fn === "it" ? "test" : "hook";
    for (const s of body) this.checkStatement(s, kind, visitHook);
    if (fn === "it") {
      this.tests += 1;
      if (!this.containsCy(body, "caption")) this.fail(call, "each it() must call cy.caption()");
      if (!visitHook && !this.containsCy(body, "visit")) {
        this.fail(call, "each it() must call cy.visit() (in the test or in a beforeEach); test isolation is off");
      }
    }
  }

  /** Statements of a zero-parameter arrow function or function expression. */
  private callbackBody(node: TS.Expression, fn: string): readonly TS.Node[] | null {
    const ts = this.ts;
    if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || node.parameters.length > 0 || node.modifiers?.length) {
      this.fail(node, `${fn}() callback must be a function with no parameters (not async)`);
      return null;
    }
    if (ts.isBlock(node.body)) return node.body.statements;
    this.concise.add(node.body);
    return [node.body];
  }

  private scopeHasVisitHook(statements: readonly TS.Node[]): boolean {
    const ts = this.ts;
    return statements.some((s) => {
      if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) return false;
      const callee = s.expression.expression;
      if (!ts.isIdentifier(callee) || !(callee.text === "before" || callee.text === "beforeEach")) return false;
      return this.containsCy([s], "visit");
    });
  }

  /** Does any cy chain under these statements call cy.<command>? */
  private containsCy(statements: readonly TS.Node[], command: string): boolean {
    const ts = this.ts;
    let found = false;
    const visit = (n: TS.Node): void => {
      if (found) return;
      if (ts.isPropertyAccessExpression(n) && n.name.text === command) {
        let root: TS.Expression = n.expression;
        while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && root.text === "cy") found = true;
      }
      ts.forEachChild(n, visit);
    };
    for (const s of statements) visit(s);
    return found;
  }

  /** `cy.a(...).b(...)...`: every link a call to an allowed command. */
  private checkCyChain(expr: TS.Expression): void {
    const ts = this.ts;
    let node: TS.Expression = expr;
    if (!ts.isCallExpression(node)) {
      this.fail(expr, "statements must be cy command chains");
      return;
    }
    while (ts.isCallExpression(node)) {
      const callee: TS.Expression = node.expression;
      if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) {
        this.fail(node, "only cy command chains may be called here");
        return;
      }
      const method = callee.name.text;
      if (!CY_COMMANDS.has(method)) {
        this.fail(callee.name, FORBIDDEN_COMMANDS.has(method) ? `cy.${method} is not allowed` : `.${method}() is not an allowed Cypress command`);
      }
      if (method === "screenshot") this.screenshots = true;
      for (const arg of node.arguments) this.checkArgument(arg, method);
      node = callee.expression;
    }
    if (!ts.isIdentifier(node) || node.text !== "cy") {
      this.fail(node, "command chains must start at `cy`");
    }
  }

  private checkArgument(arg: TS.Expression, method: string): void {
    const ts = this.ts;
    if (
      ts.isStringLiteral(arg) ||
      ts.isNoSubstitutionTemplateLiteral(arg) ||
      ts.isNumericLiteral(arg) ||
      ts.isRegularExpressionLiteral(arg) ||
      arg.kind === ts.SyntaxKind.TrueKeyword ||
      arg.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return;
    }
    if (ts.isParenthesizedExpression(arg)) return this.checkArgument(arg.expression, method);
    if (ts.isPrefixUnaryExpression(arg) && arg.operator === ts.SyntaxKind.MinusToken) return this.checkArgument(arg.operand, method);
    if (ts.isIdentifier(arg)) {
      if (!this.constants.has(arg.text)) this.fail(arg, `unknown identifier \`${arg.text}\` (only top-level constants)`);
      return;
    }
    if (ts.isBinaryExpression(arg)) {
      const ops = [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken];
      if (!ops.includes(arg.operatorToken.kind)) this.fail(arg, "only + - * / are allowed in arguments");
      this.checkArgument(arg.left, method);
      this.checkArgument(arg.right, method);
      return;
    }
    if (ts.isTemplateExpression(arg)) {
      for (const span of arg.templateSpans) this.checkArgument(span.expression, method);
      return;
    }
    if (ts.isArrayLiteralExpression(arg)) {
      for (const el of arg.elements) this.checkArgument(el, method);
      return;
    }
    if (ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
          this.fail(prop, "object arguments may only hold `key: value` pairs");
          continue;
        }
        this.checkArgument(prop.initializer, method);
      }
      return;
    }
    if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && method === "within") {
      const body = this.callbackBody(arg, "within");
      if (body) for (const s of body) this.checkStatement(s, "test", true);
      return;
    }
    this.fail(arg, `${this.kindName(arg)} is not allowed as an argument to .${method}()`);
  }
}
