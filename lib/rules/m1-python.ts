// lib/rules/m1-python.ts
// Requirement 6.1, 6.3-6.19; design R3-8.1 (M1 rows) and R3-9 (residue list).
//
// Deterministic Python 2 -> 3 analysis and rewrite engine built on web-tree-sitter
// plus the tree-sitter-python grammar. Every edit cites ruleId "M1".
import * as fs from "node:fs";
import * as path from "node:path";
import type { Parser, Tree, Node } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
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

const TREE_SITTER_PYTHON_WASM = path.join(
  "node_modules",
  "tree-sitter-python",
  "tree-sitter-python.wasm"
);

/**
 * Locates the bundled `tree-sitter-python` WASM file by walking up from the
 * current working directory (and, defensively, from this module's own
 * directory) towards the filesystem root. This deliberately avoids
 * `createRequire(...).resolve("tree-sitter-python/package.json")`: a dynamic
 * `require.resolve` expression is flagged by the Webpack/Turbopack bundler as
 * `Can't resolve <dynamic>` and pollutes the build output.
 */
function findTreeSitterPythonWasm(): string | null {
  const starts: string[] = [];
  try {
    starts.push(process.cwd());
  } catch {
    // `process.cwd()` can throw in exotic runtimes; ignore.
  }
  try {
    // `import.meta.url` is unavailable in some CJS / bundled runtimes, so this
    // is wrapped in `try/catch` for safety.
    starts.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // CJS / bundled runtime without `import.meta.url`.
  }

  const MAX_HOPS = 10;
  for (const start of starts) {
    let dir = start;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const candidate = path.join(dir, TREE_SITTER_PYTHON_WASM);
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Resolves the WASM path, falling back to `cwd/node_modules` when not found. */
function resolveTreeSitterPythonWasm(): string {
  return (
    findTreeSitterPythonWasm() ??
    path.join(process.cwd(), TREE_SITTER_PYTHON_WASM)
  );
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
      const wasmPath = resolveTreeSitterPythonWasm();
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
// Index units (byte offset vs UTF-16 code unit)
// ---------------------------------------------------------------------------
//
// `web-tree-sitter` may report `Node.startIndex` / `Node.endIndex` either as
// UTF-16 code-unit offsets (the values `String.prototype.slice` expects) or as
// UTF-8 byte offsets, depending on the binding version. When the reported
// offsets are bytes and the source contains multi-byte characters (Chinese
// comments, emoji like 🐍, ...) a JS `String.slice` with them is corrupted.
// `byteOffsetToUtf16` builds an O(N) lookup table so byte offsets can be mapped
// back to the UTF-16 code-unit indices used by JavaScript strings.

/** Builds an O(N) byte-offset -> UTF-16 code-unit index mapper for `source`. */
export function byteOffsetToUtf16(source: string): (byteOffset: number) => number {
  const byteLength = Buffer.byteLength(source, "utf8");
  const table = new Int32Array(byteLength + 1);
  let byte = 0;
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    let width = 1;
    let units = 1;
    if (code < 0x80) {
      width = 1;
    } else if (code < 0x800) {
      width = 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
      // Surrogate pair (e.g. emoji): 4 UTF-8 bytes, 2 UTF-16 code units.
      width = 4;
      units = 2;
    } else {
      width = 3;
    }
    for (let b = 0; b < width; b++) {
      table[byte + b] = index;
    }
    byte += width;
    index += units;
  }
  table[byte] = source.length;
  return (byteOffset: number): number => {
    if (byteOffset <= 0) return 0;
    if (byteOffset >= byteLength) return source.length;
    return table[byteOffset];
  };
}

/**
 * Returns a mapper that normalizes the index unit reported by a parsed tree to
 * UTF-16 code units. It is the identity function when the binding already
 * reports UTF-16 offsets (the observed behavior for web-tree-sitter 0.27.1) or
 * when the source is pure ASCII (both units agree).
 */
function makeIndexMapper(tree: Tree, source: string): (index: number) => number {
  if (source.length === Buffer.byteLength(source, "utf8")) {
    return (index) => index;
  }
  // The root node spans the whole document: in UTF-16 mode its end index equals
  // the JS string length, whereas in byte mode it equals the UTF-8 byte length.
  if (tree.rootNode.endIndex <= source.length) {
    return (index) => index;
  }
  return byteOffsetToUtf16(source);
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

/** Collects the `value` children of an `except_clause` in source order. */
function exceptValues(node: Node): Node[] {
  const values: Node[] = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === "value") values.push(node.child(i)!);
  }
  return values;
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
  "except_target_unsupported",
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
    case "except_clause": {
      if (exceptValueCount(node) < 2) return null;
      const values = exceptValues(node);
      // `except E, e:` (identifier target) is the only form M1 rewrites to
      // `except E as e:`. Tuple / attribute / subscript targets are valid in
      // Python 2 but a SyntaxError under `except E as (<target>):` in Python 3,
      // so they are left unrewritten and surfaced as unhandled residue.
      return values[1] && values[1].type === "identifier"
        ? "except_clause"
        : "except_target_unsupported";
    }
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
      // Python 3 removed the legacy octal literal: a decimal run that starts
      // with `0` and contains at least one non-zero digit (`0755`, `0644`,
      // `010`, `007`). All-zero integers (`0`, `00`, `000`) are valid Python 3
      // and must never be flagged. Hex/binary/`0o` literals carry a non-digit
      // right after the leading `0`, so they are excluded by construction.
      if (/^0[0-9]*[1-9][0-9]*$/.test(text)) return "octal";
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
  source: string,
  toUtf16: (index: number) => number
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
    start: toUtf16(printKeyword.endIndex),
    end: toUtf16(args[0].startIndex),
    replacement: "(",
  };

  let tail: PythonSplice;
  let confidence: Confidence;
  let ruleOrder: number;
  let note: string | undefined;

  if (trailingComma) {
    tail = {
      start: toUtf16(lastChild!.startIndex),
      end: toUtf16(node.endIndex),
      replacement: `, end=" "` + (chevron ? `, file=${fileTarget})` : ")"),
    };
    confidence = "medium";
    ruleOrder = chevron ? M1_ROW.PRINT_CHEVRON : M1_ROW.PRINT_TRAILING;
    note = "Py2 softspace output is not identical";
  } else {
    tail = {
      start: toUtf16(node.endIndex),
      end: toUtf16(node.endIndex),
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
  const toUtf16 = makeIndexMapper(tree, source);
  const edits: PythonPlannedEdit[] = [];
  const unknowns: UnknownRecord[] = [];
  const behaviorNotes: PythonBehaviorNote[] = [];

  walkNodes(tree.rootNode, (node) => {
    if (node.type === "print_statement") {
      const edit = buildPrintStatementEdit(node, source, toUtf16);
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
        const bareStart = toUtf16(node.startIndex);
        const bareEnd = toUtf16(node.endIndex);
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.BARE_PRINT,
          line: lineOf(node),
          confidence: "high",
          description: "bare print -> print()",
          start: bareStart,
          end: bareEnd,
          replacement: "print()",
          splices: [
            { start: bareStart, end: bareEnd, replacement: "print()" },
          ],
        });
      }
      return;
    }
    if (node.type === "except_clause") {
      const values = exceptValues(node);
      // Only `except E, e:` with an identifier target rewrites to `except E as e:`.
      // Tuple / attribute / subscript targets produce a SyntaxError under
      // `except E as (<target>):`, so they are left for manual review (and are
      // recorded as unhandled `py2_residue` through the residue list).
      if (values.length >= 2 && values[1].type === "identifier") {
        const first = values[0];
        const second = values[1];
        const exceptStart = toUtf16(first.endIndex);
        const exceptEnd = toUtf16(second.startIndex);
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.EXCEPT,
          line: lineOf(node),
          confidence: "high",
          description: "except E, e: -> except E as e:",
          start: exceptStart,
          end: exceptEnd,
          replacement: " as ",
          splices: [
            { start: exceptStart, end: exceptEnd, replacement: " as " },
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
        const argsNode = node.childForFieldName("arguments");
        const hasKeywordArgument =
          !!argsNode &&
          argsNode.namedChildren.some(
            (arg) => arg.type === "keyword_argument"
          );
        // `*args` / `**kwargs` splats forward an arbitrary number of arguments,
        // so even `unicode(*args)` (statically one argument) can be a Py2
        // `unicode(bytes, encoding, errors)` call. Rewriting it to `str(*args)`
        // would change arity/meaning, so keep it unrewritten and flag the
        // decoding as ambiguous.
        const hasSplatArgument =
          !!argsNode &&
          argsNode.namedChildren.some(
            (arg) =>
              arg.type === "list_splat" || arg.type === "dictionary_splat"
          );
        // `unicode(bytes, encoding, errors)`, `unicode(encoding="utf-8")`, and
        // `unicode(*args)` / `unicode(**kwargs)` all change meaning/arity when
        // rewritten to `str(...)`: Python 3 `str()` takes no `encoding=`
        // keyword (TypeError) and no splat with the Py2 arity. Keep them
        // unrewritten and flag the decoding as ambiguous.
        if (
          totalArgumentCount(node) >= 2 ||
          hasKeywordArgument ||
          hasSplatArgument
        ) {
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
        const unicodeStart = toUtf16(fn.startIndex);
        const unicodeEnd = toUtf16(fn.endIndex);
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.UNICODE,
          line: lineOf(node),
          confidence: "medium",
          description: "unicode(...) -> str(...)",
          note: reviewNote,
          start: unicodeStart,
          end: unicodeEnd,
          replacement: "str",
          splices: [
            { start: unicodeStart, end: unicodeEnd, replacement: "str" },
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
        const iterStart = toUtf16(attrNode.startIndex);
        const iterEnd = toUtf16(attrNode.endIndex);
        edits.push({
          ruleId: "M1",
          ruleOrder: M1_ROW.ITERATOR,
          line: lineOf(node),
          confidence: "medium",
          description: `.${attr}() -> .${ITERATOR_MAP[attr]}()`,
          start: iterStart,
          end: iterEnd,
          replacement: ITERATOR_MAP[attr],
          splices: [
            {
              start: iterStart,
              end: iterEnd,
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
  try {
    return planFromTree(tree, source, file);
  } finally {
    tree.delete?.();
  }
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

export type DeclaredPythonStatus = "py2_only" | "py3_compatible" | "unknown";

export interface DeclaredPythonVersion {
  py2Only: boolean;
  declared?: string;
  path?: string;
  reason?: string;
  /** The classified status of `declared` (see `classifyVersionSpecifier`). */
  declaredStatus?: DeclaredPythonStatus;
}

interface ParsedVersion {
  epoch: number;
  release: number[];
  pre: { stage: "a" | "b" | "rc"; num: number } | null;
  post: number | null;
  dev: number | null;
}

/**
 * Parses a PEP 440 version (or a plain dotted release) into comparable parts.
 * Supports the epoch (`N!`), a release segment, pre-releases (`aN`, `bN`,
 * `rcN`, `alpha`, `beta`, `pre`, `preview`), `.postN` (`rev`, `r`), and
 * `.devN` suffixes. Returns null when the value is not a valid version.
 */
function parsePep440(value: string): ParsedVersion | null {
  const match = value
    .trim()
    .match(
      /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?$/i
    );
  if (!match) return null;
  const release = match[2].split(".").map((part) => parseInt(part, 10));
  if (release.some((part) => Number.isNaN(part))) return null;
  const stageRaw = match[3]?.toLowerCase();
  const pre = stageRaw
    ? {
        stage: (stageRaw === "a" || stageRaw === "alpha"
          ? "a"
          : stageRaw === "b" || stageRaw === "beta"
          ? "b"
          : "rc") as "a" | "b" | "rc",
        num: match[4] ? parseInt(match[4], 10) : 0,
      }
    : null;
  return {
    epoch: match[1] ? parseInt(match[1], 10) : 0,
    release,
    pre,
    post: match[5] !== undefined ? parseInt(match[5] || "0", 10) : null,
    dev: match[6] !== undefined ? parseInt(match[6] || "0", 10) : null,
  };
}

/**
 * PEP 440 suffix ordering: a `.devN`-only release sorts lowest, then `a` < `b`
 * < `rc`, then the final release, then `.postN`.
 */
function pep440SuffixKey(version: ParsedVersion): number[] {
  if (version.pre) {
    const rank = version.pre.stage === "a" ? 0 : version.pre.stage === "b" ? 1 : 2;
    return [rank, version.pre.num, version.dev !== null ? -1 : 0, version.post !== null ? 1 : 0];
  }
  if (version.post !== null) return [4, version.post, version.dev !== null ? -1 : 0, 0];
  if (version.dev !== null) return [-1, version.dev, 0, 0];
  return [3, 0, 0, 0];
}

function compareParsedVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  const length = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < length; i++) {
    const left = a.release[i] ?? 0;
    const right = b.release[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  const keyA = pep440SuffixKey(a);
  const keyB = pep440SuffixKey(b);
  for (let i = 0; i < keyA.length; i++) {
    if (keyA[i] !== keyB[i]) return keyA[i] < keyB[i] ? -1 : 1;
  }
  return 0;
}

function toParsedVersion(release: number[]): ParsedVersion {
  return { epoch: 0, release, pre: null, post: null, dev: null };
}

interface ParsedClause {
  op: string;
  version: ParsedVersion;
  star: boolean;
}

function parseClause(clause: string): ParsedClause | null {
  let text = clause.trim();
  let star = false;
  if (text.endsWith(".*")) {
    star = true;
    text = text.slice(0, -2);
  }
  const opMatch = text.match(/^(==|!=|>=|<=|~=|>|<)?\s*(.+)$/);
  if (!opMatch) return null;
  const version = parsePep440(opMatch[2]);
  if (!version) return null;
  return { op: opMatch[1] ?? "==", version, star };
}

function prefixMatches(version: number[], prefix: number[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if ((version[i] ?? 0) !== prefix[i]) return false;
  }
  return true;
}

/**
 * True when two versions share the same release segment (trailing zeros
 * padded), e.g. `3.11` and `3.11.0` or `3.11` and `3.11.post1`.
 */
function sameRelease(a: ParsedVersion, b: ParsedVersion): boolean {
  const length = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < length; i++) {
    if ((a.release[i] ?? 0) !== (b.release[i] ?? 0)) return false;
  }
  return true;
}

function versionMatchesClause(version: ParsedVersion, clause: ParsedClause): boolean {
  const { op, version: spec, star } = clause;
  switch (op) {
    case "==":
      return star
        ? prefixMatches(version.release, spec.release)
        : compareParsedVersions(version, spec) === 0;
    case "!=":
      return star
        ? !prefixMatches(version.release, spec.release)
        : compareParsedVersions(version, spec) !== 0;
    case ">=":
      return compareParsedVersions(version, spec) >= 0;
    case ">":
      // PEP 440: an exclusive ordered comparison `>V` MUST NOT match a
      // post-release of `V` unless `V` itself is a post-release. Otherwise
      // `.postN` sorts above the final release and would wrongly satisfy it.
      if (compareParsedVersions(version, spec) <= 0) return false;
      if (
        spec.post === null &&
        version.post !== null &&
        sameRelease(version, spec)
      ) {
        return false;
      }
      return true;
    case "<=":
      return compareParsedVersions(version, spec) <= 0;
    case "<":
      // PEP 440: an exclusive ordered comparison `<V` MUST NOT match a
      // pre-release or dev-release of `V` unless `V` itself specifies a
      // pre-release / dev-release. Otherwise `3.11a1` / `3.11.dev0` sort below
      // the final release and would wrongly satisfy it.
      if (compareParsedVersions(version, spec) >= 0) return false;
      if (
        spec.pre === null &&
        spec.dev === null &&
        (version.pre !== null || version.dev !== null) &&
        sameRelease(version, spec)
      ) {
        return false;
      }
      return true;
    case "~=": {
      if (compareParsedVersions(version, spec) < 0) return false;
      const prefix =
        spec.release.length > 1
          ? spec.release.slice(0, spec.release.length - 1)
          : spec.release;
      return prefixMatches(version.release, prefix);
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

/**
 * Classifies a `requires-python` / `python_requires` specifier:
 * - `py2_only`: admits a Python 2 version and no Python 3 version.
 * - `py3_compatible`: admits at least one Python 3 version.
 * - `unknown`: the specifier cannot be parsed/evaluated (e.g. malformed), so
 *   callers should stay conservative and halt M1.
 */
export function classifyVersionSpecifier(specifier: string): DeclaredPythonStatus {
  const clauses = specifier
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return "unknown";

  const parsed: ParsedClause[] = [];
  for (const clause of clauses) {
    const parsedClause = parseClause(clause);
    if (!parsedClause) return "unknown";
    if (parsedClause.star && parsedClause.op !== "==" && parsedClause.op !== "!=") {
      return "unknown";
    }
    parsed.push(parsedClause);
  }

  const satisfiesAll = (version: ParsedVersion) =>
    parsed.every((clause) => versionMatchesClause(version, clause));

  // Sparsely sampling the fixed candidate arrays cannot represent every narrow
  // pin (for example `==2.7.5`, `>=2.7.5, <=2.7.10`, `==3.9.7`, or a
  // pre-release pin such as `>=3.13.0rc1`). Derive additional probes from the
  // parsed clauses themselves so exact, narrow, and PEP 440 pre-release
  // specifiers are classified against real versions.
  const py2Probes: ParsedVersion[] = PY2_CANDIDATE_VERSIONS.map(toParsedVersion);
  const py3Probes: ParsedVersion[] = PY3_CANDIDATE_VERSIONS.map(toParsedVersion);
  for (const clause of parsed) {
    const release = clause.version.release;
    const p0 = release[0];
    if (p0 !== 2 && p0 !== 3) continue;
    const p1 = release[1] ?? 0;
    const p2 = release[2] ?? 0;
    const target = p0 === 2 ? py2Probes : py3Probes;
    target.push(clause.version);
    target.push(toParsedVersion([p0, p1, p2]));
    target.push(toParsedVersion([p0, p1, p2 + 1]));
    target.push(toParsedVersion([p0, p1, Math.max(0, p2 - 1)]));
  }

  if (py3Probes.some(satisfiesAll)) return "py3_compatible";
  if (py2Probes.some(satisfiesAll)) return "py2_only";
  return "unknown";
}

/** Returns true when the specifier admits no Python 3 version (or cannot be safely evaluated). */
export function isPy2OnlySpecifier(specifier: string): boolean {
  return classifyVersionSpecifier(specifier) !== "py3_compatible";
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
      const declaredStatus = classifyVersionSpecifier(spec);
      return {
        // `unknown` (unparseable) specifiers stay conservative and halt M1.
        py2Only: declaredStatus !== "py3_compatible",
        declared: spec,
        path: normalizeFilePath(manifest.path),
        declaredStatus,
        reason:
          declaredStatus === "py2_only"
            ? "py2_only_declared"
            : declaredStatus === "unknown"
            ? "version_specifier_unparseable"
            : "py3_compatible_declared",
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

  // The source tree and the re-parsed output tree both own WASM memory. Read
  // everything needed into plain data, then release both trees in `finally`.
  let outputTree: Tree | null = null;
  try {
    const plan = planFromTree(tree, body, file);
    for (const unknown of plan.unknowns) unknowns.push(unknown);

    const outputBody = applyEditsToOriginal(body, plan.edits);
    const output = (bom ? "\uFEFF" : "") + outputBody;
    const residueBefore = countPythonResidue(tree);
    outputTree = parsePython(outputBody);
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
  } finally {
    tree.delete?.();
    outputTree?.delete?.();
  }
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

