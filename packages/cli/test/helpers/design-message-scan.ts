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
  /** Number of elements added to a joined message array that were classified. */
  messageArrayElementsExamined: number;
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

/**
 * Both diagnostic factories.
 *
 * `designDiagnostic()` is the type-enforced one: its message parameter is
 * `CatalogBackedDesignMessage`, so a hand-written string there fails to compile rather than failing
 * this scan. `diagnostic()` is the shared factory the other five gates use with plain strings.
 *
 * The scan covers both because "the design gates use the typed factory" is itself something that
 * has to be checked -- the day a design gate goes back to `diagnostic()`, `DesignGate.evaluate`'s
 * return type rejects it, but only for as long as that gate keeps its `DesignGate<Id>` annotation.
 */
const DIAGNOSTIC_FACTORY_NAMES = new Set(["diagnostic", "designDiagnostic"]);

function isDiagnosticFactoryCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    DIAGNOSTIC_FACTORY_NAMES.has(node.expression.text)
  );
}

interface GateDeclaration {
  id: string;
  literal: ts.ObjectLiteralExpression;
}

/** Strips `as T`, `satisfies T` and parentheses, which change no value and hide the literal. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Type names that mark a declaration as a gate.
 *
 * `DesignGate<Id>` is `Gate` narrowed so that `evaluate` may only return catalogued diagnostics.
 * It has to be listed here as well: when the design gates moved to that annotation, this scan
 * stopped recognising them and reported `design_gate_missing` for both -- loudly, which is the
 * behaviour that was wanted, but it means the list is a thing to keep current rather than a
 * property that follows from anything.
 */
const GATE_TYPE_NAMES = new Set(["Gate", "DesignGate"]);

/** `Gate`/`DesignGate<...>`, or an array of either, ignoring which spelling a declaration used. */
function namesGateType(type: ts.TypeNode | undefined): { isGate: boolean; isGateArray: boolean } {
  if (!type) return { isGate: false, isGateArray: false };
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return { isGate: GATE_TYPE_NAMES.has(type.typeName.text), isGateArray: false };
  }
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return { isGate: false, isGateArray: namesGateType(type.type).isGateArray };
  }
  if (ts.isArrayTypeNode(type)) {
    return { isGate: false, isGateArray: namesGateType(type.elementType).isGate };
  }
  return { isGate: false, isGateArray: false };
}

function gateFromLiteral(literal: ts.Expression, into: GateDeclaration[]): void {
  const object = unwrap(literal);
  if (!ts.isObjectLiteralExpression(object)) return;
  for (const prop of object.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "id" &&
      ts.isStringLiteral(prop.initializer)
    ) {
      into.push({ id: prop.initializer.text, literal: object });
    }
  }
}

/**
 * Every `{ id: "...", ... }` object literal that a declaration marks as a `Gate`.
 *
 * Keying on `Gate` rather than on any object with an `id` keeps unrelated literals (options,
 * records, fixtures) out without needing a name convention or a position. All four ways this
 * codebase could spell that marking are accepted -- annotation, `satisfies`, `as`, and membership
 * in a `Gate[]` -- because an unrecognised spelling does not fail safe in a useful way: the gate's
 * diagnostics become `diagnostic_outside_gate`, so a perfectly correct non-design gate turns the
 * suite red for its syntax. Failing a legitimate gate for how it was written is the same class of
 * defect as failing it for where it was written, which is what this whole check was reworked to
 * stop doing. A gate built some other way (returned from a factory function, say) is still loud
 * rather than silent; that is the fail-closed floor, not a target to aim for.
 */
function findGateDeclarations(sf: ts.SourceFile): GateDeclaration[] {
  const gates: GateDeclaration[] = [];
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    const init = node.initializer;
    if (!init) return;
    const { isGate, isGateArray } = namesGateType(node.type);
    const unwrapped = unwrap(init);

    if (isGateArray && ts.isArrayLiteralExpression(unwrapped)) {
      for (const element of unwrapped.elements) gateFromLiteral(element, gates);
      return;
    }
    // `satisfies Gate` / `as Gate` carry the marking on the initializer instead of the variable.
    const markedOnInitializer =
      (ts.isSatisfiesExpression(init) || ts.isAsExpression(init)) &&
      namesGateType(init.type).isGate;
    if (isGate || markedOnInitializer) gateFromLiteral(init, gates);
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
      // All four fields, not three: `gateId`/`severity`/`message` alone also describes ordinary
      // log and config objects, and this check has no type information to tell them apart. A
      // literal carrying the Diagnostic shape exactly is the narrowest signal available here.
      const looksLikeDiagnostic = (["gateId", "code", "severity", "message"] as const).every((f) =>
        names.includes(f),
      );
      if (!looksLikeDiagnostic) return;
      let inFactory = false;
      for (let p: ts.Node | undefined = node; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name && DIAGNOSTIC_FACTORY_NAMES.has(p.name.text)) {
          inFactory = true;
        }
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
  let messageArrayElementsExamined = 0;

  /** The name a property is written under, however it was spelled. */
  function propertyKey(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
      return name.expression.text;
    }
    return null;
  }

  walk(sf, (node) => {
    // `{ message }` -- the value comes from a binding this scan cannot follow, so it is reported
    // rather than skipped. Skipping it is how a hand-assembled string reaches a message field
    // while every visible `message:` site stays catalog-backed.
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "message") {
      messageSitesExamined += 1;
      violations.push({
        kind: "non_catalog_message",
        detail:
          "message is passed by shorthand ({ message }), so its value cannot be classified here",
        line: lineOf(node, sf),
      });
      return;
    }
    if (!ts.isPropertyAssignment(node)) return;
    if (propertyKey(node.name) !== "message") return;
    messageSitesExamined += 1;
    const value = unwrap(node.initializer);
    if (isCatalogBackedExpression(value)) return;
    // `joinDesignMessageLines(lines)`: the helper fixes the separator and refuses an empty array,
    // so the only thing left to audit is what went into the array.
    if (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === "joinDesignMessageLines" &&
      value.arguments.length === 1 &&
      value.arguments[0] &&
      ts.isIdentifier(value.arguments[0])
    ) {
      joinedArrays.add((value.arguments[0] as ts.Identifier).text);
      return;
    }
    if (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      value.expression.name.text === "join" &&
      ts.isIdentifier(value.expression.expression)
    ) {
      // The separator is part of the emitted text. A join on "\n" only concatenates whole
      // catalogued lines; a join on " -- " or "\nNote: " assembles a sentence out of them, which
      // is precisely what R46 forbids, and it would otherwise pass unexamined.
      const separator = value.arguments[0];
      const separatorText =
        separator && ts.isStringLiteralLike(separator) ? separator.text : "<non-literal>";
      if (separatorText.trim() !== "") {
        violations.push({
          kind: "non_catalog_message",
          detail: `message lines are joined on ${JSON.stringify(separatorText)}, which contributes text of its own`,
          line: lineOf(node, sf),
        });
        return;
      }
      joinedArrays.add(value.expression.expression.text);
      return;
    }
    violations.push({
      kind: "non_catalog_message",
      detail: `message value is neither formatDesignMessage(...) nor <array>.join(...): ${value.getText(sf)}`,
      line: lineOf(node, sf),
    });
  });

  // Array methods that return a new value and leave the receiver alone. Anything outside this set
  // and outside {push, unshift} is treated as unclassifiable rather than assumed harmless: the
  // point of the audit is that every line in the joined message came from the catalog, and a
  // method this scan does not model could put one there.
  const READ_ONLY_ARRAY_METHODS = new Set([
    "at",
    "concat",
    "entries",
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flat",
    "flatMap",
    "forEach",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "map",
    "reduce",
    "reduceRight",
    "slice",
    "some",
    "toString",
    "values",
  ]);

  for (const arrayName of joinedArrays) {
    let declarationSeen = false;
    walk(sf, (node) => {
      // Declaration: must start empty, or its seed text ends up in the joined message unchecked.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === arrayName
      ) {
        declarationSeen = true;
        const init = node.initializer && unwrap(node.initializer);
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
      // Method calls on it: catalogued lines may be added; anything this scan cannot model is loud.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === arrayName
      ) {
        const method = node.expression.name.text;
        if (READ_ONLY_ARRAY_METHODS.has(method)) return;
        if (method !== "push" && method !== "unshift") {
          violations.push({
            kind: "unapproved_message_array_mutation",
            detail: `"${arrayName}" is modified by .${method}(...), which this scan cannot classify`,
            line: lineOf(node, sf),
          });
          return;
        }
        for (const arg of node.arguments) {
          messageArrayElementsExamined += 1;
          if (!isCatalogBackedExpression(unwrap(arg))) {
            violations.push({
              kind: "non_catalog_message_line",
              detail: `"${arrayName}" receives a line that is not formatDesignMessage(...): ${arg.getText(sf)}`,
              line: lineOf(node, sf),
            });
          }
        }
      }
    });
    // A joined array with no declaration in this file (a parameter, an import) cannot be audited
    // at all, and an unauditable array must not read as an audited one.
    if (!declarationSeen) {
      violations.push({
        kind: "unapproved_message_array_mutation",
        detail: `"${arrayName}" is joined into a message but is not declared in this file, so its contents cannot be audited`,
        line: 0,
      });
    }
  }

  return { violations, messageSitesExamined, messageArrayElementsExamined };
}
