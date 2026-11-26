// lib/rules/m1-python.ts
// Requirement 6.1, 6.3-6.19; design R3-8.1 (M1 rows) and R3-9 (residue list).
//
// Deterministic Python 2 -> 3 analysis and rewrite engine built on web-tree-sitter
// plus the tree-sitter-python grammar. Every edit cites ruleId "M1".
import * as fs from "node:fs";
import * as path from "node:path";
import type { Parser, Tree, Node } from "web-tree-sitter";
import { createRequire } from "node:module";
import * as Diff from "diff";
import type { Confidence, UnknownRecord } from "../grimoire/types";
import type { PatchStep } from "../grimoire/gate-js";
import { normalizeFilePath } from "../grimoire/gate-js";

export const M1_RULE_ID = "M1" as const;

/** Fixed row order for the eight R3-8.1 rewrite rows. */
export const M1_ROW = {
  PRINT: 1,
  PRINT_TRAILING: 2,
  PRINT_CHEVRON: 3,
  BARE_PRINT: 4,
  PRINT_CALL: 5,
  EXCEPT: 6,
  UNICODE: 7,
  ITERATOR: 8,
} as const;

export interface PythonSplice {
  start: number;
  end: number;
  replacement: string;
}

export interface PythonPlannedEdit {
  ruleId: "M1";
  ruleOrder: number;
  line: number;
  confidence: Confidence;
  description: string;
  note?: string;
  /** Primary splice (first), mirrored for callers that only read one range. */
  start: number;
  end: number;
  replacement: string;
  /** All splices of this atomic edit (head + tail/comma for print rows). */
  splices?: PythonSplice[];
  [key: string]: unknown;
}

/** Returns the splices of an edit, falling back to its primary range. */
export function editSplices(edit: PythonPlannedEdit): PythonSplice[] {
  if (Array.isArray(edit.splices) && edit.splices.length > 0) {
    return edit.splices;
  }
  return [{ start: edit.start, end: edit.end, replacement: edit.replacement }];
}

export interface PythonBehaviorNote {
  ruleId: "M1";
  file: string;
  line: number;
  note: string;
}

export interface PythonResidueItem {
  kind: string;
  handled: boolean;
  line: number;
  column: number;
  startIndex: number;
  endIndex: number;
  text: string;
}

export interface PythonPlan {
  file: string;
  edits: PythonPlannedEdit[];
  conflicts: PythonPlannedEdit[];
  unknowns: UnknownRecord[];
  behaviorNotes: PythonBehaviorNote[];
  residue: PythonResidueItem[];
  hasFuturePrint: boolean;
  unicodeBound: boolean;
}

export interface M1Result {
  file: string;
  source: string;
  output: string;
  bom: boolean;
  newline: "\r\n" | "\n";
  edits: PythonPlannedEdit[];
  acceptedEdits: PythonPlannedEdit[];
  conflicts: PythonPlannedEdit[];
  unknowns: UnknownRecord[];
  behaviorNotes: PythonBehaviorNote[];
  residueBefore: number;
  residueAfter: number;
  label: "m1-clean" | "m1-partial";
  reverted: boolean;
  revertReason?: string;
  compat: boolean;
  notes: string;
  diff: string;
  step: PatchStep;
}

export interface AnalyzePythonOptions {
  /** Raw bytes, when available, are validated as strict UTF-8 first. */
  rawBytes?: Uint8Array;
  /** When the repository declares Python 2 only, M1 must not edit anything. */
  py2Only?: boolean;
}

// ---------------------------------------------------------------------------
// Parser initialization and caching
// ---------------------------------------------------------------------------

let parserPromise: Promise<Parser> | null = null;
let pythonParser: Parser | null = null;

export function isPythonParserReady(): boolean {
  return pythonParser !== null;
}

export function getPythonParser(): Parser | null {
  return pythonParser;
}

function makeRequire(): NodeRequire {
  try {
    return createRequire(import.meta.url);
  } catch {
    return createRequire(process.cwd() + "/__m1_python__.js");
  }
}

const GLOBAL_PYTHON_PARSE_SYNC_KEY = "__ggPythonParseSync";

function registerGlobalPythonSync(): void {
  (globalThis as Record<string, unknown>)[GLOBAL_PYTHON_PARSE_SYNC_KEY] = (
    source: string,
    file: string
  ): PythonPlan | null => planPythonEdits(source, file);
}

/** Initializes and caches the Python parser (Language singleton loaded once). */
export async function initPythonParser(): Promise<Parser> {
  if (pythonParser) {
    registerGlobalPythonSync();
    return pythonParser;
  }
  if (!parserPromise) {
    parserPromise = (async () => {
      const { Parser, Language } = await import("web-tree-sitter");
      await Parser.init();
      const req = makeRequire();
      let wasmPath = "";
      try {
        const pyPkgDir = path.dirname(
          req.resolve(["tree-sitter-python", "package.json"].join("/"))
        );
        const candidate = path.join(
          pyPkgDir,
          ["tree-sitter-python", "wasm"].join(".")
        );
        if (fs.existsSync(candidate)) {
          wasmPath = candidate;
        }
      } catch {
        // Fallback below for bundled runtimes.
      }
      if (!wasmPath) {
        wasmPath = path.join(
          process.cwd(),
          "node_modules",
          "tree-sitter-python",
          ["tree-sitter-python", "wasm"].join(".")
        );
      }
      const language = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);
      pythonParser = parser;
      registerGlobalPythonSync();
      return parser;
    })().catch((err) => {
      parserPromise = null;
      throw err;
    });
  }
  return parserPromise;
}

/**
 * Parses Python source with the cached parser. Returns null when the parser is
 * not initialized yet or when parsing fails (safe timeout / null handling).
 */
export function parsePython(source: string): Tree | null {
  if (!pythonParser) return null;
  try {
    const tree = pythonParser.parse(source);
    return tree ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generic AST helpers
// ---------------------------------------------------------------------------

function walkNodes(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function hasChildOfType(node: Node, type: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === type) return true;
  }
  return false;
}

function exceptValueCount(node: Node): number {
  let count = 0;
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === "value") count += 1;
  }
  return count;
}

function positionalArgumentCount(call: Node): number {
  const args = call.childForFieldName("arguments");
  if (!args) return 0;
  let count = 0;
  for (const child of args.namedChildren) {
    if (child.type === "keyword_argument") continue;
    if (child.type === "comment") continue;
    count += 1;
  }
  return count;
}

function totalArgumentCount(call: Node): number {
  const args = call.childForFieldName("arguments");
  if (!args) return 0;
  let count = 0;
  for (const child of args.namedChildren) {
    if (child.type === "comment") continue;
    count += 1;
  }
  return count;
}

function hasEmptyArguments(call: Node): boolean {
  const args = call.childForFieldName("arguments");
  return !!args && args.namedChildren.length === 0;
}

function attributeName(attributeCall: Node): string | null {
  const fn = attributeCall.childForFieldName("function");
  if (!fn || fn.type !== "attribute") return null;
  const attr = fn.childForFieldName("attribute");
  if (!attr || attr.type !== "identifier") return null;
  return attr.text;
}

const ITERATOR_NAMES = new Set(["iteritems", "iterkeys", "itervalues"]);
const ITERATOR_MAP: Record<string, string> = {
  iteritems: "items",
  iterkeys: "keys",
  itervalues: "values",
};

const UNHANDLED_RESIDUE_KINDS = new Set([
  "exec_statement",
  "not_equal",
  "backtick_string",
  "ur_prefix",
  "octal",
  "long",
  "tuple_param",
  "raise_statement",
]);

// ---------------------------------------------------------------------------
// Encoding validation
// ---------------------------------------------------------------------------

export function hasLoneSurrogate(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Reads a `# -*- coding: ... -*-` cookie from the first two lines, if any. */
export function codingCookieName(source: string): string | null {
  const firstTwoLines = source.split("\n").slice(0, 2).join("\n");
  const match = firstTwoLines.match(/coding[:=]\s*([-\w.]+)/);
  return match ? match[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Residue list (design R3-9)
// ---------------------------------------------------------------------------

function classifyResidue(node: Node): string | null {
  switch (node.type) {
    case "print_statement":
      return "print_statement";
    case "exec_statement":
      return "exec_statement";
    case "chevron":
      return "chevron";
    case "<>":
      return "not_equal";
    case "raise_statement":
      return hasChildOfType(node, "expression_list") ? "raise_statement" : null;
    case "except_clause":
      return exceptValueCount(node) >= 2 ? "except_clause" : null;
    case "expression_statement": {
      if (
        node.childCount === 1 &&
        node.child(0)?.type === "identifier" &&
        node.child(0)?.text === "print"
      ) {
        return "bare_print";
      }
      return null;
    }
    case "string": {
      const start = node.child(0);
      const prefix =
        start && start.type === "string_start" ? start.text.toLowerCase() : "";
      if (prefix.includes("`")) return "backtick_string";
      if (prefix.includes("u") && prefix.includes("r")) return "ur_prefix";
      return null;
    }
    case "integer": {
      const text = node.text;
      if (/^0[0-9]+$/.test(text)) return "octal";
      if (/[Ll]$/.test(text)) return "long";
      return null;
    }
    case "tuple_pattern": {
      const parent = node.parent;
      if (
        parent &&
        (parent.type === "parameters" || parent.type === "lambda_parameters")
      ) {
        return "tuple_param";
      }
      return null;
    }
    case "call": {
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      if (fn.type === "identifier" && fn.text === "unicode") {
        return "unicode_call";
      }
      const attr = attributeName(node);
      if (attr && ITERATOR_NAMES.has(attr)) return "iterator_call";
      return null;
    }
    default:
      return null;
  }
}

/** Collects every residue occurrence with its position (design R3-9). */
export function collectResidue(tree: Tree): PythonResidueItem[] {
  const items: PythonResidueItem[] = [];
  walkNodes(tree.rootNode, (node) => {
    const kind = classifyResidue(node);
    if (kind === null) return;
    items.push({
      kind,
      handled: !UNHANDLED_RESIDUE_KINDS.has(kind),
      line: lineOf(node),
      column: node.startPosition.column,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      text: node.text,
    });
  });
  return items;
}

/** Total residue count of a tree (used by the monotone gate). */
export function countPythonResidue(tree: Tree): number {
  return collectResidue(tree).length;
}

// ---------------------------------------------------------------------------
// Name binding detection (for the unicode row)
// ---------------------------------------------------------------------------

function collectTargetNames(node: Node, out: Set<string>): void {
  if (node.type === "identifier") {
    out.add(node.text);
    return;
  }
  if (
    node.type === "pattern_list" ||
    node.type === "tuple_pattern" ||
    node.type === "list_pattern" ||
    node.type === "parenthesized_expression" ||
    node.type === "list_splat_pattern" ||
    node.type === "dictionary_splat_pattern" ||
    node.type === "as_pattern_target"
  ) {
    for (const child of node.namedChildren) collectTargetNames(child, out);
  }
}

function collectParameterNames(node: Node, out: Set<string>): void {
  switch (node.type) {
    case "identifier":
      out.add(node.text);
      return;
    case "default_parameter":
    case "typed_default_parameter": {
      const name = node.childForFieldName("name");
      if (name) collectTargetNames(name, out);
      return;
    }
    case "typed_parameter": {
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === "type") continue;
        const child = node.child(i);
        if (child && child.type !== "type" && child.isNamed) {
          collectParameterNames(child, out);
        }
      }
      return;
    }
    case "list_splat_pattern":
    case "dictionary_splat_pattern":
    case "tuple_pattern":
    case "list_pattern":
    case "pattern_list":
    case "parenthesized_expression": {
      for (const child of node.namedChildren) {
        collectParameterNames(child, out);
      }
      return;
    }
    default:
      return;
  }
}

function collectBoundNames(tree: Tree): Set<string> {
  const bound = new Set<string>();
  walkNodes(tree.rootNode, (node) => {
    switch (node.type) {
      case "assignment":
      case "augmented_assignment": {
        const left = node.childForFieldName("left");
        if (left) collectTargetNames(left, bound);
        break;
      }
      case "named_expression": {
        const name = node.childForFieldName("name");
        if (name) collectTargetNames(name, bound);
        break;
      }
      case "function_definition":
      case "class_definition": {
        const name = node.childForFieldName("name");
        if (name && name.type === "identifier") bound.add(name.text);
        break;
      }
      case "parameters":
      case "lambda_parameters": {
        for (const child of node.namedChildren) {
          collectParameterNames(child, bound);
        }
        break;
      }
      case "for_statement":
      case "for_in_clause": {
        const left = node.childForFieldName("left");
        if (left) collectTargetNames(left, bound);
        break;
      }
      case "as_pattern_target": {
        collectTargetNames(node, bound);
        break;
      }
      case "except_clause": {
        const values: Node[] = [];
        for (let i = 0; i < node.childCount; i++) {
          if (node.fieldNameForChild(i) === "value") values.push(node.child(i)!);
        }
        if (values.length >= 2) {
          collectTargetNames(values[1], bound);
        }
        break;
      }
      case "global_statement":
      case "nonlocal_statement": {
        for (const child of node.namedChildren) {
          if (child.type === "identifier") bound.add(child.text);
        }
        break;
      }
      case "import_statement":
      case "import_from_statement": {
        for (const part of node.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
          if (part === "unicode") bound.add("unicode");
        }
        break;
      }
      default:
        break;
    }
  });
  return bound;
}

function hasFuturePrint(tree: Tree): boolean {
  let found = false;
  walkNodes(tree.rootNode, (node) => {
    if (
      node.type === "future_import_statement" &&
      /\bprint_function\b/.test(node.text)
    ) {
      found = true;
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Edit planning (the eight R3-8.1 rows)
// ---------------------------------------------------------------------------

function buildPrintStatementEdit(
  node: Node,
  source: string
): PythonPlannedEdit | null {
  const printKeyword = node.child(0);
  if (!printKeyword || printKeyword.type !== "print") return null;

  const args: Node[] = [];
  let chevron: Node | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (node.fieldNameForChild(i) === "argument") args.push(child);
    else if (child.type === "chevron") chevron = child;
  }
  if (args.length === 0) return null;

  const lastChild = node.child(node.childCount - 1);
  const trailingComma = !!lastChild && lastChild.type === ",";
  const fileTarget = chevron ? chevron.text.slice(2) : "";

  const head: PythonSplice = {
    start: printKeyword.endIndex,
    end: args[0].startIndex,
    replacement: "(",
  };

  let tail: PythonSplice;
  let confidence: Confidence;
  let ruleOrder: number;
  let note: string | undefined;

  if (trailingComma) {
    tail = {
      start: lastChild!.startIndex,
      end: node.endIndex,
      replacement: `, end=" "` + (chevron ? `, file=${fileTarget})` : ")"),
    };
    confidence = "medium";
    ruleOrder = chevron ? M1_ROW.PRINT_CHEVRON : M1_ROW.PRINT_TRAILING;
    note = "Py2 softspace output is not identical";
  } else {
    tail = {
      start: node.endIndex,
      end: node.endIndex,
      replacement: chevron ? `, file=${fileTarget})` : ")",
    };
    confidence = "high";
    ruleOrder = chevron ? M1_ROW.PRINT_CHEVRON : M1_ROW.PRINT;
  }

  return {
    ruleId: "M1",
    ruleOrder,
    line: lineOf(node),
    confidence,
    description: chevron
      ? "print >>f statement -> print(..., file=f) call"
      : "print statement -> print(...) call",
    note,
    start: head.start,
    end: head.end,
    replacement: head.replacement,
    splices: [head, tail],
  };
}

function isIteratorUse(call: Node): boolean {
  const parent = call.parent;
  if (!parent) return false;
  if (parent.type === "attribute") {
    const attr = parent.childForFieldName("attribute");
    if (attr && attr.type === "identifier" && attr.text === "next") return true;
  }
  if (parent.type === "argument_list") {
    const grandparent = parent.parent;
    if (grandparent && grandparent.type === "call") {
      const fn = grandparent.childForFieldName("function");
      if (fn && fn.type === "identifier" && fn.text === "next") return true;
    }
  }
  return false;
}

export interface ConflictResolution {
  edits: PythonPlannedEdit[];
  conflicts: PythonPlannedEdit[];
  unknowns: UnknownRecord[];
}

/**
 * Requirement 6.16: when two edits in one file have overlapping splices, keep
 * the earlier edit (by start offset, then row order) and record the later one
 * with reason `edit_conflict`.
 */
export function resolveEditConflicts(
  edits: PythonPlannedEdit[],
  file: string
): ConflictResolution {
  const sorted = [...edits].sort(
    (a, b) => a.start - b.start || a.ruleOrder - b.ruleOrder
  );
  const accepted: PythonPlannedEdit[] = [];
  const conflicts: PythonPlannedEdit[] = [];
  const acceptedSplices: PythonSplice[] = [];
  const unknowns: UnknownRecord[] = [];

  for (const edit of sorted) {
    const splices = editSplices(edit);
    const overlaps = splices.some((splice) =>
      acceptedSplices.some(
        (accepted) => splice.start < accepted.end && accepted.start < splice.end
      )
    );
    if (overlaps) {
      conflicts.push(edit);
      unknowns.push({
        ruleId: "M1",
        reason: "edit_conflict",
        file,
        line: edit.line,
      });
    } else {
      accepted.push(edit);
      for (const splice of splices) acceptedSplices.push(splice);
    }
  }

  return { edits: accepted, conflicts, unknowns };
}

/** Builds the plan against an already parsed tree. */
export function planFromTree(
  tree: Tree,
  source: string,
  file: string
): PythonPlan {
  const hasFuture = hasFuturePrint(tree);
  const unicodeBound = collectBoundNames(tree).has("unicode");
  const edits: PythonPlannedEdit[] = [];
  const unknowns: UnknownRecord[] = [];
  const behaviorNotes: PythonBehaviorNote[] = [];

  walkNodes(tree.rootNode, (node) => {
    if (node.type === "print_statement") {
      const edit = buildPrintStatementEdit(node, source);
      if (edit) {
        edits.push(edit);
        if (edit.note) {
          behaviorNotes.push({
            ruleId: "M1",
            file,
            line: edit.line,
            note: edit.note,
          });
        }
      }
      return;
    }
    if (node.type === "expression_statement") {
      if (
        node.childCount === 1 &&
        node.child(0)?.type === "identifier" &&
        node.child(0)?.text === "print"
      ) {
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.BARE_PRINT,
          line: lineOf(node),
          confidence: "high",
          description: "bare print -> print()",
          start: node.startIndex,
          end: node.endIndex,
          replacement: "print()",
          splices: [
            { start: node.startIndex, end: node.endIndex, replacement: "print()" },
          ],
        });
      }
      return;
    }
    if (node.type === "except_clause") {
      const values: Node[] = [];
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === "value") values.push(node.child(i)!);
      }
      if (values.length >= 2) {
        const first = values[0];
        const second = values[1];
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.EXCEPT,
          line: lineOf(node),
          confidence: "high",
          description: "except E, e: -> except E as e:",
          start: first.endIndex,
          end: second.startIndex,
          replacement: " as ",
          splices: [
            { start: first.endIndex, end: second.startIndex, replacement: " as " },
          ],
        });
      }
      return;
    }
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (!fn) return;

      if (fn.type === "identifier" && fn.text === "print") {
        if (positionalArgumentCount(node) >= 2 && !hasFuture) {
          behaviorNotes.push({
            ruleId: "M1",
            file,
            line: lineOf(node),
            note: "Py2 prints a tuple",
          });
        }
        return;
      }

      if (fn.type === "identifier" && fn.text === "unicode") {
        if (unicodeBound) {
          unknowns.push({
            ruleId: "M1",
            reason: "unicode_rebound",
            file,
            line: lineOf(node),
          });
          return;
        }
        if (totalArgumentCount(node) >= 2) {
          unknowns.push({
            ruleId: "M1",
            reason: "unicode_decoding_ambiguous",
            file,
            line: lineOf(node),
          });
          return;
        }
        const reviewNote =
          "Py2 bytes vs text unknown: verify argument is not a Py2 byte string decoded via unicode()";
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.UNICODE,
          line: lineOf(node),
          confidence: "medium",
          description: "unicode(...) -> str(...)",
          note: reviewNote,
          start: fn.startIndex,
          end: fn.endIndex,
          replacement: "str",
          splices: [
            { start: fn.startIndex, end: fn.endIndex, replacement: "str" },
          ],
        });
        behaviorNotes.push({
          ruleId: "M1",
          file,
          line: lineOf(node),
          note: reviewNote,
        });
        return;
      }

      const attr = attributeName(node);
      if (attr === "unicode") {
        unknowns.push({
          ruleId: "M1",
          reason: "unicode_rebound",
          file,
          line: lineOf(node),
        });
        return;
      }
      if (attr && ITERATOR_NAMES.has(attr)) {
        if (!hasEmptyArguments(node)) return;
        if (isIteratorUse(node)) {
          unknowns.push({
            ruleId: "M1",
            reason: "iterator_use",
            file,
            line: lineOf(node),
          });
          return;
        }
        const attrNode = fn.childForFieldName("attribute")!;
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.ITERATOR,
          line: lineOf(node),
          confidence: "medium",
          description: `.${attr}() -> .${ITERATOR_MAP[attr]}()`,
          start: attrNode.startIndex,
          end: attrNode.endIndex,
          replacement: ITERATOR_MAP[attr],
          splices: [
            {
              start: attrNode.startIndex,
              end: attrNode.endIndex,
              replacement: ITERATOR_MAP[attr],
            },
          ],
        });
      }
      return;
    }
  });

  const residue = collectResidue(tree);
  for (const item of residue) {
    if (!item.handled) {
      unknowns.push({
        ruleId: "M1",
        reason: "py2_residue",
        file,
        line: item.line,
      });
    }
  }

  // Overlapping edits: keep the earlier one (start offset, then row order).
  const resolution = resolveEditConflicts(edits, file);
  for (const unknown of resolution.unknowns) unknowns.push(unknown);

  return {
    file,
    edits: resolution.edits,
    conflicts: resolution.conflicts,
    unknowns,
    behaviorNotes,
    residue,
    hasFuturePrint: hasFuture,
    unicodeBound,
  };
}


/** Parses and plans M1 edits. Returns null when the parser is not ready. */
export function planPythonEdits(
  source: string,
  file: string
): PythonPlan | null {
  const tree = parsePython(source);
  if (!tree) return null;
  return planFromTree(tree, source, file);
}

// ---------------------------------------------------------------------------
// Atomic splice engine
// ---------------------------------------------------------------------------

interface IndexedSplice extends PythonSplice {
  editIndex: number;
  spliceIndex: number;
}

/**
 * Applies a set of (non-overlapping) edits atomically. Positions of later
 * splices are mapped through the splices already applied, so nested edits such
 * as `print unicode(x)` both apply cleanly.
 */
export function applyEditsToOriginal(
  original: string,
  edits: PythonPlannedEdit[]
): string {
  const splices: IndexedSplice[] = [];
  edits.forEach((edit, editIndex) => {
    editSplices(edit).forEach((splice, spliceIndex) => {
      splices.push({ ...splice, editIndex, spliceIndex });
    });
  });
  splices.sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      a.editIndex - b.editIndex ||
      a.spliceIndex - b.spliceIndex
  );

  let text = original;
  let delta = 0;
  for (const splice of splices) {
    const start = splice.start + delta;
    const end = splice.end + delta;
    text = text.slice(0, start) + splice.replacement + text.slice(end);
    delta += splice.replacement.length - (splice.end - splice.start);
  }
  return text;
}

export function countHunks(diff: string): number {
  const matches = diff.match(/^@@ /gm);
  return matches ? matches.length : 0;
}

export function createPythonDiff(
  original: string,
  patched: string,
  file: string
): string {
  return Diff.createTwoFilesPatch(
    file,
    file,
    original,
    patched,
    undefined,
    undefined,
    { context: 3 }
  );
}


// ---------------------------------------------------------------------------
// Declared Python version (halt M1 on Python-2-only declarations)
// ---------------------------------------------------------------------------

export interface DeclaredPythonVersion {
  py2Only: boolean;
  declared?: string;
  path?: string;
  reason?: string;
}

function parseVersionParts(value: string): number[] {
  return value
    .split(".")
    .map((part) => parseInt(part, 10))
    .filter((part) => !Number.isNaN(part));
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

interface ParsedClause {
  op: string;
  parts: number[];
  star: boolean;
}

function prefixMatches(version: number[], prefix: number[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if ((version[i] ?? 0) !== prefix[i]) return false;
  }
  return true;
}

function versionMatchesClause(version: number[], clause: ParsedClause): boolean {
  const { op, parts, star } = clause;
  switch (op) {
    case "==":
      return star
        ? prefixMatches(version, parts)
        : compareVersions(version, parts) === 0;
    case "!=":
      return star
        ? !prefixMatches(version, parts)
        : compareVersions(version, parts) !== 0;
    case ">=":
      return compareVersions(version, parts) >= 0;
    case ">":
      return compareVersions(version, parts) > 0;
    case "<=":
      return compareVersions(version, parts) <= 0;
    case "<":
      return compareVersions(version, parts) < 0;
    case "~=": {
      if (compareVersions(version, parts) < 0) return false;
      const prefix = parts.length > 1 ? parts.slice(0, parts.length - 1) : parts;
      return prefixMatches(version, prefix);
    }
    default:
      return false;
  }
}

const PY2_CANDIDATE_VERSIONS: number[][] = [
  [2, 0, 0],
  [2, 5, 0],
  [2, 6, 0],
  [2, 7, 0],
  [2, 7, 18],
];

const PY3_CANDIDATE_VERSIONS: number[][] = (() => {
  const versions: number[][] = [];
  for (let minor = 0; minor <= 15; minor++) {
    versions.push([3, minor, 0]);
    versions.push([3, minor, 1]);
  }
  return versions;
})();

/** Returns true when the specifier admits no Python 3 version (or cannot be safely evaluated). */
export function isPy2OnlySpecifier(specifier: string): boolean {
  const clauses = specifier
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return false;

  const parsed: ParsedClause[] = [];
  for (const clause of clauses) {
    const match = clause.match(
      /^(==|!=|>=|<=|~=|>|<)?\s*([0-9]+(?:\.[0-9]+)*)(\.\*)?$/
    );
    if (!match) {
      return true;
    }
    const op = match[1] ?? "==";
    const version = match[2];
    const star = !!match[3];
    if (star && op !== "==" && op !== "!=") {
      return true;
    }
    parsed.push({ op, parts: parseVersionParts(version), star });
  }

  const satisfiesAll = (v: number[]) =>
    parsed.every((clause) => versionMatchesClause(v, clause));

  if (PY3_CANDIDATE_VERSIONS.some(satisfiesAll)) return false;
  return PY2_CANDIDATE_VERSIONS.some(satisfiesAll);
}

function extractSpecifier(content: string, keyword: string): string | undefined {
  const isToml = keyword === "requires-python";
  const n = content.length;
  let i = 0;
  let quote: "'" | '"' | null = null;
  let triple = false;
  let lineStart = true;

  while (i < n) {
    const ch = content[i];

    if (quote !== null) {
      const supportsEscape = !isToml || quote === '"';
      if (supportsEscape && ch === "\\") {
        i += i + 1 < n ? 2 : 1;
        continue;
      }
      if (triple) {
        if (content.startsWith(quote.repeat(3), i)) {
          i += 3;
          quote = null;
          triple = false;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === "\n") {
        quote = null;
        lineStart = true;
        i += 1;
        continue;
      }
      if (ch === quote) {
        i += 1;
        quote = null;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === "#") {
      while (i < n && content[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "\n") {
      lineStart = true;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      triple = content.startsWith(ch.repeat(3), i);
      quote = ch;
      i += triple ? 3 : 1;
      lineStart = false;
      continue;
    }

    if (content.startsWith(keyword, i)) {
      const prevChar = i > 0 ? content[i - 1] : "";
      const boundaryOk = isToml
        ? lineStart
        : i === 0 || /[\s(,]/.test(prevChar);
      if (boundaryOk) {
        const after = content.slice(i + keyword.length);
        const match = after.match(
          /^[ \t]*=[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)')/
        );
        if (match) {
          return (match[1] ?? match[2] ?? "").trim();
        }
      }
    }

    if (ch !== " " && ch !== "\t" && ch !== "\r") {
      lineStart = false;
    }
    i += 1;
  }

  return undefined;
}

export function checkDeclaredPythonVersion(
  manifests: Array<{ path: string; content: string }>
): DeclaredPythonVersion {
  for (const manifest of manifests ?? []) {
    const path = normalizeFilePath(manifest.path).toLowerCase();
    let spec: string | undefined;
    if (path.endsWith("pyproject.toml")) {
      spec = extractSpecifier(manifest.content, "requires-python");
    } else if (path.endsWith("setup.py")) {
      spec = extractSpecifier(manifest.content, "python_requires");
    }
    if (spec) {
      return {
        py2Only: isPy2OnlySpecifier(spec),
        declared: spec,
        path: normalizeFilePath(manifest.path),
        reason: "py2_only_declared",
      };
    }
  }
  return { py2Only: false };
}

// ---------------------------------------------------------------------------
// Full analysis (transform + diff + PatchStep)
// ---------------------------------------------------------------------------

function emptyResult(
  source: string,
  file: string,
  bom: boolean,
  newline: "\r\n" | "\n",
  reason: string,
  unknowns: UnknownRecord[]
): M1Result {
  const step: PatchStep = {
    id: `M1:${file}`,
    ruleId: "M1",
    file,
    diff: "",
    hunks: 0,
    compat: false,
    behavior: "preserved",
    reverted: true,
    revertReason: reason,
    acceptedEdits: 0,
    acceptedEditsCount: 0,
    edits: [],
    plannedEdits: [],
  };
  return {
    file,
    source,
    output: source,
    bom,
    newline,
    edits: [],
    acceptedEdits: [],
    conflicts: [],
    unknowns,
    behaviorNotes: [],
    residueBefore: 0,
    residueAfter: 0,
    label: "m1-partial",
    reverted: true,
    revertReason: reason,
    compat: false,
    notes: "",
    diff: "",
    step,
  };
}

export function analyzePython(
  source: string,
  fileOrOptions?: string | AnalyzePythonOptions,
  maybeOptions?: AnalyzePythonOptions
): M1Result {
  const file =
    typeof fileOrOptions === "string" && fileOrOptions.length > 0
      ? normalizeFilePath(fileOrOptions)
      : "file.py";
  const options: AnalyzePythonOptions =
    typeof fileOrOptions === "object" && fileOrOptions !== null
      ? fileOrOptions
      : maybeOptions ?? {};

  const bom = source.length > 0 && source.charCodeAt(0) === 0xfeff;
  const body = bom ? source.slice(1) : source;
  const newline: "\r\n" | "\n" = source.includes("\r\n") ? "\r\n" : "\n";
  const unknowns: UnknownRecord[] = [];

  const encodingBad =
    (options.rawBytes !== undefined && !isValidUtf8(options.rawBytes)) ||
    hasLoneSurrogate(body) ||
    (() => {
      const cookie = codingCookieName(body);
      const cookieNonUtf8 =
        cookie !== null && cookie !== "utf-8" && cookie !== "utf8";
      return cookieNonUtf8 && body.includes("\uFFFD");
    })();

  if (encodingBad) {
    unknowns.push({ ruleId: "M1", reason: "encoding_unsupported", file });
    return emptyResult(
      source,
      file,
      bom,
      newline,
      "encoding_unsupported",
      unknowns
    );
  }
  if (options.py2Only) {
    unknowns.push({ ruleId: "M1", reason: "py2_only_declared", file });
    return emptyResult(
      source,
      file,
      bom,
      newline,
      "py2_only_declared",
      unknowns
    );
  }

  const tree = parsePython(body);
  if (!tree) {
    unknowns.push({ ruleId: "M1", reason: "parse_timeout", file });
    return emptyResult(source, file, bom, newline, "parse_timeout", unknowns);
  }

  const plan = planFromTree(tree, body, file);
  for (const unknown of plan.unknowns) unknowns.push(unknown);

  const outputBody = applyEditsToOriginal(body, plan.edits);
  const output = (bom ? "\uFEFF" : "") + outputBody;
  const residueBefore = countPythonResidue(tree);
  const outputTree = parsePython(outputBody);
  const residueAfter = outputTree
    ? countPythonResidue(outputTree)
    : residueBefore;
  const label: "m1-clean" | "m1-partial" =
    residueAfter === 0 ? "m1-clean" : "m1-partial";

  const planned = [...plan.edits, ...plan.conflicts];
  const reverted = planned.length > 0 && plan.edits.length === 0;
  const diff =
    plan.edits.length > 0 ? createPythonDiff(source, output, file) : "";
  const notes = plan.behaviorNotes.map((item) => item.note).join("; ");

  const step: PatchStep = {
    id: `M1:${file}`,
    ruleId: "M1",
    file,
    diff,
    hunks: countHunks(diff),
    compat: false,
    behavior: notes ? "changed" : "preserved",
    notes: notes || undefined,
    reverted,
    revertReason: reverted ? "all_edits_rejected" : undefined,
    acceptedEdits: plan.edits.length,
    acceptedEditsCount: plan.edits.length,
    edits: planned,
    plannedEdits: planned,
  };

  return {
    file,
    source,
    output,
    bom,
    newline,
    edits: planned,
    acceptedEdits: plan.edits,
    conflicts: plan.conflicts,
    unknowns,
    behaviorNotes: plan.behaviorNotes,
    residueBefore,
    residueAfter,
    label,
    reverted,
    revertReason: reverted ? "all_edits_rejected" : undefined,
    compat: false,
    notes,
    diff,
    step,
  };
}

export function transformPython(
  source: string,
  file: string,
  options?: AnalyzePythonOptions
): M1Result {
  return analyzePython(source, file, options);
}

/** Requirement 6.15: `applyM1(applyM1(f)) === applyM1(f)`. */
export function applyM1(source: string, file?: string): string {
  return analyzePython(source, file ?? "file.py").output;
}

