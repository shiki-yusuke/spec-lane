import ts from "typescript";

/**
 * Static scanners backing R45/R46 ("every message the new commands emit SHALL be addressed by a
 * stable identifier in a message catalog").
 *
 * ## Why this file exists at all
 *
 * The first version of this check lived inline in design-message-catalog.test.ts and identified
 * the design gates **by their position in gate.ts**: everything between
 * `export const designEstablishmentGate` and `export interface GateEvaluation`. That range is not
 * a property of the design track -- it is a property of where someone happened to type. When
 * `promotionWeakeningGate` was added it landed inside that range, its (legitimately plain-string)
 * diagnostics were swept up as "design gate messages", and the check went red for a gate it was
 * never about. The gate was moved above `designEstablishmentGate` to make the check pass again.
 * That workaround is correct and would have been needed again for the next gate.
 *
 * So the scanners here determine membership **structurally**: a diagnostic belongs to a design gate
 * when the `Gate` object literal it is written inside declares `id: "design_establishment"` or
 * `id: "design_decision"`. Where a gate sits in the file is then irrelevant, which is exactly the
 * property design-message-scan.test.ts pins down with a synthetic source that places an unrelated
 * gate in the old positional range.
 *
 * ## Why an AST and not a regex
 *
 * The predecessor matched `"error",` / `"warning",` and read the next 40 characters. Architect
 * review (2026-08-20) listed what that lets through, and the list is the reason this file uses the
 * TypeScript parser instead: a severity passed by variable never matches; a `"..."` inside a
 * comment matches when it should not; `formatDesignMessage(...) + " suffix"` passes a
 * `startsWith("formatDesignMessage(")` test while being exactly the fragment-concatenation R46
 * forbids. None of those are edge cases a longer regex fixes -- the fourth argument is an arbitrary
 * TypeScript expression, so classifying it needs a parser. `typescript` is already a devDependency
 * of this package (it is what typechecks it), so this adds no new dependency; `ts-morph` would.
 *
 * ## Fail-closed, and what that costs
 *
 * A scanner that silently finds nothing looks identical to a scanner that finds no violations.
 * Each scan therefore reports what it *examined* alongside what it rejected, and the callers assert
 * on both. Constructs the scanner cannot classify are reported as violations rather than skipped:
 * a diagnostic whose gate id is not a literal, a `diagnostic()` call outside every gate, a
 * `Diagnostic` object built without the factory. Each of those is a way to emit a message that
 * membership-by-id cannot see, so each has to be loud rather than absent.
 *
 * Deliberately NOT covered (recorded so absence is not read as coverage): a message assembled in a
 * different file and passed in. The scanners read one file's syntax tree and do not follow imports,
 * so a helper elsewhere returning a plain string is invisible to them -- `checkEngineRefCompleteness`
 * in commands/design.ts is a real instance today. Closing that needs the type system (a branded
 * `CatalogBackedDesignMessage` that string concatenation cannot produce), not a bigger scanner.
 */

export interface Violation {
  /** Stable machine-readable reason, so tests can assert on the kind rather than on wording. */
  kind:
    | "parse_error"
    | "design_gate_missing"
    | "non_literal_gate_id"
    | "diagnostic_outside_gate"
    | "gate_id_mismatch"
    | "raw_diagnostic_object"
    | "unexpected_argument_count"
    | "non_catalog_message"
    | "non_catalog_message_line"
    | "unapproved_message_array_mutation";
  detail: string;
  line: number;
}

export interface GateScanResult {
  violations: Violation[];
  /** Ids of every `Gate` object literal found, in source order. Lets a caller prove it saw both. */
  gateIdsFound: string[];
  /** `[gateId, code]` of every design-gate diagnostic examined -- the check's actual reach. */
  designDiagnosticsExamined: Array<[string, string]>;
}

export interface CommandScanResult {
  violations: Violation[];
  /** Number of `message:` property values classified. */
  messageSitesExamined: number;
  /** Number of pushes into a message array classified. */
  messageArrayPushesExamined: number;
}

/** The design track's gates, named by the id they declare rather than by where they are written. */
export const DESIGN_TRACK_GATE_IDS = ["design_establishment", "design_decision"] as const;

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function parse(fileName: string, source: string): { sf: ts.SourceFile; violations: Violation[] } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  // `parseDiagnostics` is not on the public SourceFile type, but it is where the parser records
  // syntax errors. Reading it matters because ts.createSourceFile never throws: handed unparsable
  // input it returns a partial tree, and a scanner walking that tree would report "no violations"
  // for a file it could not read. If the property is ever gone, treat that as a violation too --
  // an unverifiable parse must not read as a clean one.
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics === undefined) {
    return {
      sf,
      violations: [
        {
          kind: "parse_error",
          detail:
            "TypeScript no longer exposes parseDiagnostics; syntax errors can no longer be detected",
          line: 0,
        },
      ],
    };
  }
  return {
    sf,
    violations: parseDiagnostics.map((d) => ({
      kind: "parse_error" as const,
      detail: ts.flattenDiagnosticMessageText(d.messageText, " "),
      line: d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line + 1,
    })),
  };
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** `formatDesignMessage(...)` as the WHOLE expression -- not merely as its leftmost token. */
export function isCatalogBackedExpression(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "formatDesignMessage"
  );
}

function isDiagnosticFactoryCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "diagnostic"
  );
}

interface GateDeclaration {
  id: string;
  literal: ts.ObjectLiteralExpression;
}

/**
 * Every `{ id: "...", ... }` object literal assigned to a variable annotated `Gate`.
 *
 * Matching on the `Gate` type annotation rather than on any object with an `id` keeps unrelated
 * literals (options, records, fixtures) out without needing a name convention or a position.
 */
function findGateDeclarations(sf: ts.SourceFile): GateDeclaration[] {
  const gates: GateDeclaration[] = [];
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!node.type || !ts.isTypeReferenceNode(node.type)) return;
    if (!ts.isIdentifier(node.type.typeName) || node.type.typeName.text !== "Gate") return;
    const init = node.initializer;
    if (!init || !ts.isObjectLiteralExpression(init)) return;
    for (const prop of init.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "id" &&
        ts.isStringLiteral(prop.initializer)
      ) {
        gates.push({ id: prop.initializer.text, literal: init });
      }
    }
  });
  return gates;
}

/**
 * Scans a gate module for design-track messages that are not catalog-backed.
 *
 * The design-specific rule (fourth argument must be `formatDesignMessage(...)`) applies only to
 * diagnostics inside a gate declaring a design id. The other rules apply file-wide, because they
 * are what makes membership-by-id trustworthy in the first place: if a diagnostic can carry a
 * non-literal id, sit outside every gate, claim another gate's id, or be built without the factory,
 * then "not a design diagnostic" no longer follows from "not matched here".
 */
export function scanGateSource(
  source: string,
  designGateIds: readonly string[] = DESIGN_TRACK_GATE_IDS,
): GateScanResult {
  const { sf, violations } = parse("gate.ts", source);
  const gates = findGateDeclarations(sf);
  const gateIdsFound = gates.map((g) => g.id);
  const designDiagnosticsExamined: Array<[string, string]> = [];

  for (const id of designGateIds) {
    if (!gateIdsFound.includes(id)) {
      violations.push({
        kind: "design_gate_missing",
        detail: `no Gate declares id "${id}"; the scan would silently check nothing for it`,
        line: 0,
      });
    }
  }

  // Which gate (if any) each diagnostic() call sits inside, found by subtree rather than by offset.
  const owner = new Map<ts.CallExpression, string>();
  for (const gate of gates) {
    walk(gate.literal, (node) => {
      if (isDiagnosticFactoryCall(node)) owner.set(node, gate.id);
    });
  }

  walk(sf, (node) => {
    if (isDiagnosticFactoryCall(node)) {
      const enclosing = owner.get(node);
      const first = node.arguments[0];
      const literalId = first && ts.isStringLiteral(first) ? first.text : null;

      if (literalId === null) {
        violations.push({
          kind: "non_literal_gate_id",
          detail: `diagnostic() called with a non-literal gate id (${first ? first.getText(sf) : "no arguments"}); membership by id cannot classify it`,
          line: lineOf(node, sf),
        });
        return;
      }
      if (enclosing === undefined) {
        violations.push({
          kind: "diagnostic_outside_gate",
          detail: `diagnostic("${literalId}", ...) is not inside any Gate declaration, so no gate owns it`,
          line: lineOf(node, sf),
        });
        return;
      }
      if (enclosing !== literalId) {
        violations.push({
          kind: "gate_id_mismatch",
          detail: `diagnostic inside gate "${enclosing}" labels itself "${literalId}"`,
          line: lineOf(node, sf),
        });
        return;
      }
      if (!designGateIds.includes(literalId)) return;

      const code = node.arguments[1];
      designDiagnosticsExamined.push([
        literalId,
        code && ts.isStringLiteral(code) ? code.text : "<non-literal code>",
      ]);

      if (node.arguments.length !== 4) {
        violations.push({
          kind: "unexpected_argument_count",
          detail: `diagnostic("${literalId}", ...) has ${node.arguments.length} arguments, expected 4; the message argument cannot be located`,
          line: lineOf(node, sf),
        });
        return;
      }
      const message = node.arguments[3] as ts.Expression;
      if (!isCatalogBackedExpression(message)) {
        violations.push({
          kind: "non_catalog_message",
          detail: `design gate "${literalId}" emits a message that is not formatDesignMessage(...): ${message.getText(sf)}`,
          line: lineOf(node, sf),
        });
      }
      return;
    }

    // A Diagnostic built by hand bypasses the factory, and with it every check above.
    // The factory's own return literal is the one legitimate instance, so it is excluded by
    // checking whether the literal sits inside a function named `diagnostic`.
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties
        .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null))
        .filter((n): n is string => n !== null);
      const looksLikeDiagnostic =
        names.includes("gateId") && names.includes("severity") && names.includes("message");
      if (!looksLikeDiagnostic) return;
      let inFactory = false;
      for (let p: ts.Node | undefined = node; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name?.text === "diagnostic") inFactory = true;
      }
      if (inFactory) return;
      violations.push({
        kind: "raw_diagnostic_object",
        detail: "a Diagnostic object is constructed without the diagnostic() factory",
        line: lineOf(node, sf),
      });
    }
  });

  return { violations, gateIdsFound, designDiagnosticsExamined };
}

/**
 * Scans a command module for `message:` values that are not catalog-backed.
 *
 * Two shapes are accepted, matching what commands/design.ts actually does: the value is
 * `formatDesignMessage(...)`, or it is `<array>.join(...)` where `<array>` is a local array that
 * nothing but `formatDesignMessage(...)` was ever pushed into. The second shape is why the array's
 * every mutation is examined and not just its pushes: an array seeded with a literal at
 * declaration, or extended by `unshift`, or reassigned, joins into exactly the hand-written text
 * R46 forbids while still reading as `lines.join("\n")` at the message site.
 */
export function scanCommandSource(source: string): CommandScanResult {
  const { sf, violations } = parse("command.ts", source);

  // Arrays whose `.join(...)` is used as a message value; each must then survive the mutation audit.
  const joinedArrays = new Set<string>();
  let messageSitesExamined = 0;
  let messageArrayPushesExamined = 0;

  walk(sf, (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== "message") return;
    messageSitesExamined += 1;
    const value = node.initializer;
    if (isCatalogBackedExpression(value)) return;
    if (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      value.expression.name.text === "join" &&
      ts.isIdentifier(value.expression.expression)
    ) {
      joinedArrays.add(value.expression.expression.text);
      return;
    }
    violations.push({
      kind: "non_catalog_message",
      detail: `message value is neither formatDesignMessage(...) nor <array>.join(...): ${value.getText(sf)}`,
      line: lineOf(node, sf),
    });
  });

  for (const arrayName of joinedArrays) {
    walk(sf, (node) => {
      // Declaration: must start empty, or its seed text ends up in the joined message unchecked.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === arrayName
      ) {
        const init = node.initializer;
        const startsEmpty = init && ts.isArrayLiteralExpression(init) && init.elements.length === 0;
        if (!startsEmpty) {
          violations.push({
            kind: "unapproved_message_array_mutation",
            detail: `"${arrayName}" is joined into a message but is not declared as an empty array: ${init ? init.getText(sf) : "<no initializer>"}`,
            line: lineOf(node, sf),
          });
        }
        return;
      }
      // Assignment back into the array or one of its slots.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ((ts.isIdentifier(node.left) && node.left.text === arrayName) ||
          (ts.isElementAccessExpression(node.left) &&
            ts.isIdentifier(node.left.expression) &&
            node.left.expression.text === arrayName))
      ) {
        violations.push({
          kind: "unapproved_message_array_mutation",
          detail: `"${arrayName}" is assigned to after declaration: ${node.getText(sf)}`,
          line: lineOf(node, sf),
        });
        return;
      }
      // Method calls on it: push of catalog messages only; anything else is unclassifiable.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === arrayName
      ) {
        const method = node.expression.name.text;
        if (method === "join") return;
        if (method !== "push") {
          violations.push({
            kind: "unapproved_message_array_mutation",
            detail: `"${arrayName}" is modified by .${method}(...), which this scan cannot classify`,
            line: lineOf(node, sf),
          });
          return;
        }
        for (const arg of node.arguments) {
          messageArrayPushesExamined += 1;
          if (!isCatalogBackedExpression(arg)) {
            violations.push({
              kind: "non_catalog_message_line",
              detail: `"${arrayName}" receives a line that is not formatDesignMessage(...): ${arg.getText(sf)}`,
              line: lineOf(node, sf),
            });
          }
        }
      }
    });
  }

  return { violations, messageSitesExamined, messageArrayPushesExamined };
}
