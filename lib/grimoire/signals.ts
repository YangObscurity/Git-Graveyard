import { readFileSync } from "node:fs";
import { parse, type ParserPlugin } from "@babel/parser";
import type { Signal, RuleId, Confidence, UnknownRecord } from "./types";
import { isPythonFile } from "./gate-js";
import type { PythonPlan } from "../rules/m1-python";

export type DetectSignalsInputFile = {
  path: string;
  content?: string;
  text?: string;
  source?: string;
  manifestDir?: string;
  manifestDirectory?: string;
  [key: string]: unknown;
};

export type DetectSignalsInput =
  | readonly DetectSignalsInputFile[]
  | Iterable<DetectSignalsInputFile>
  | { files?: readonly DetectSignalsInputFile[]; scannedFiles?: readonly DetectSignalsInputFile[] }
  | DetectSignalsInputFile;

export interface DetectSignalsOptions {
  unknowns?: UnknownRecord[];
}

export interface DetectSignalsResult extends Array<Signal> {
  signals: Signal[];
  unknowns: UnknownRecord[];
  parseErrors: UnknownRecord[];
}

function normalizePath(filePath: string): string {
  if (typeof filePath !== "string") return "";
  let p = filePath.replace(/\\/g, "/");
  p = p.replace(/^\.?\/+/, "");
  p = p.replace(/\/+/g, "/");
  return p.replace(/\/+$/, "");
}

function isBabelParseable(filePath: string): boolean {
  if (typeof filePath !== "string") return false;
  const norm = normalizePath(filePath).toLowerCase();
  const basename = norm.slice(norm.lastIndexOf("/") + 1);
  return (
    basename.endsWith(".js") ||
    basename.endsWith(".cjs") ||
    basename.endsWith(".mjs") ||
    basename.endsWith(".jsx") ||
    basename.endsWith(".ts") ||
    basename.endsWith(".tsx")
  );
}

function getManifestDir(file: DetectSignalsInputFile): string {
  if (typeof file.manifestDir === "string" && file.manifestDir.length > 0) {
    return file.manifestDir;
  }
  if (typeof file.manifestDirectory === "string" && file.manifestDirectory.length > 0) {
    return file.manifestDirectory;
  }
  const norm = normalizePath(file.path);
  const idx = norm.lastIndexOf("/");
  if (idx === -1) {
    return ".";
  }
  const dir = norm.slice(0, idx);
  return dir.length === 0 ? "." : dir;
}

function isRequestPackage(name: string): boolean {
  if (typeof name !== "string") return false;
  return (
    name === "request" ||
    name.startsWith("request/") ||
    name === "request-promise" ||
    name.startsWith("request-promise/") ||
    name === "request-promise-native" ||
    name.startsWith("request-promise-native/") ||
    name === "request-promise-any" ||
    name.startsWith("request-promise-any/")
  );
}

function isRequestPromisePackage(name: string): boolean {
  if (typeof name !== "string") return false;
  return (
    name === "request-promise" ||
    name.startsWith("request-promise/") ||
    name === "request-promise-native" ||
    name.startsWith("request-promise-native/") ||
    name === "request-promise-any" ||
    name.startsWith("request-promise-any/")
  );
}

function parseSource(source: string, filePath: string): any {
  const norm = normalizePath(filePath).toLowerCase();
  const basePlugins: ParserPlugin[] = norm.endsWith(".tsx")
    ? ["typescript", "jsx"]
    : norm.endsWith(".ts")
    ? ["typescript"]
    : ["jsx"];

  const isMjs = norm.endsWith(".mjs");
  const isCjs = norm.endsWith(".cjs");

  const pluginAttempts: ParserPlugin[][] = [
    basePlugins,
    [...basePlugins, "decorators"],
    [...basePlugins, "decorators-legacy"],
  ];

  const sourceTypes: ("module" | "script" | "unambiguous")[] = isMjs
    ? ["module"]
    : isCjs
    ? ["script", "unambiguous", "module"]
    : ["unambiguous", "module", "script"];

  let lastError: unknown;

  for (const plugins of pluginAttempts) {
    for (const sourceType of sourceTypes) {
      try {
        return parse(source, {
          sourceType,
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
          allowImportExportEverywhere: true,
          allowSuperOutsideMethod: true,
          allowUndeclaredExports: true,
          plugins,
        });
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError;
}

function walk(node: unknown, visitor: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visitor);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === "string") {
    visitor(obj);
  }
  for (const key of Object.keys(obj)) {
    if (
      key === "loc" ||
      key === "comments" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments" ||
      key === "extra"
    ) {
      continue;
    }
    const val = obj[key];
    if (val && typeof val === "object") {
      walk(val, visitor);
    }
  }
}

function toFileList(input: DetectSignalsInput): DetectSignalsInputFile[] {
  return Array.isArray(input)
    ? input
    : input && typeof input === "object" && "files" in input && Array.isArray((input as any).files)
    ? (input as any).files
    : input && typeof input === "object" && "scannedFiles" in input && Array.isArray((input as any).scannedFiles)
    ? (input as any).scannedFiles
    : input && typeof (input as any)[Symbol.iterator] === "function"
    ? Array.from(input as Iterable<DetectSignalsInputFile>)
    : input && typeof input === "object" && typeof (input as any).path === "string"
    ? [input as DetectSignalsInputFile]
    : [];
}

function finalizeSignals(
  signals: Signal[],
  unknowns: UnknownRecord[],
  options?: DetectSignalsOptions
): DetectSignalsResult {
  const seenSignals = new Set<string>();
  const uniqueSignals: Signal[] = [];
  for (const s of signals) {
    const key = `${s.file}:${s.line}:${s.column}:${s.ruleId}:${s.matched}`;
    if (!seenSignals.has(key)) {
      seenSignals.add(key);
      uniqueSignals.push(s);
    }
  }

  uniqueSignals.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });

  if (options?.unknowns) {
    for (const u of unknowns) {
      options.unknowns.push(u);
    }
  }

  return Object.assign(uniqueSignals, {
    signals: uniqueSignals,
    unknowns,
    parseErrors: unknowns.filter((u) => u.reason === "parse_error"),
  }) as DetectSignalsResult;
}

function residueConfidenceFor(kind: string): Confidence {
  switch (kind) {
    case "unicode_call":
    case "iterator_call":
      return "medium";
    default:
      return "high";
  }
}

/** Masks Python comments and string literals (newlines preserved). */
function maskPython(source: string): string {
  const chars = source.split("");
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let triple = false;

  while (i < n) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\n" || ch === "\r") {
        if (!triple) quote = null;
        i++;
        continue;
      }
      if (ch === "\\") {
        chars[i] = " ";
        // Preserve quote state across backslash line-continuations (\\\n and \\\r\n).
        if (i + 1 < n && source[i + 1] === "\n") {
          i += 2;
        } else if (i + 2 < n && source[i + 1] === "\r" && source[i + 2] === "\n") {
          i += 3;
        } else if (i + 1 < n) {
          chars[i + 1] = " ";
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (triple) {
        if (source.startsWith(quote.repeat(3), i)) {
          chars[i] = " ";
          chars[i + 1] = " ";
          chars[i + 2] = " ";
          i += 3;
          quote = null;
          triple = false;
          continue;
        }
        chars[i] = " ";
        i++;
        continue;
      }
      if (ch === quote) {
        chars[i] = " ";
        i++;
        quote = null;
        continue;
      }
      chars[i] = " ";
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < n && source[i] !== "\n" && source[i] !== "\r") {
        chars[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      triple = source.startsWith(ch.repeat(3), i);
      chars[i] = " ";
      if (triple) {
        chars[i + 1] = " ";
        chars[i + 2] = " ";
        i += 3;
        quote = ch;
      } else {
        i += 1;
        quote = ch;
      }
      continue;
    }
    i++;
  }
  return chars.join("");
}

function lineColumnAt(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") {
      line += 1;
      last = i + 1;
    }
  }
  return { line, column: index - last };
}

function hasTopLevelCommaInCall(masked: string, openParenIndex: number): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = openParenIndex + 1; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      if (parenDepth === 0) return false;
      parenDepth -= 1;
    } else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
    } else if (ch === "{") braceDepth += 1;
    else if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
    } else if (
      ch === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return true;
    }
  }
  return false;
}

function findTopLevelCommaIndex(text: string): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      if (parenDepth > 0) parenDepth -= 1;
    } else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
    } else if (ch === "{") braceDepth += 1;
    else if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
    } else if (
      ch === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return i;
    }
  }
  return -1;
}

/** Comment/string-aware lexical fallback for synchronous Python detection. */
function lexicalPythonSignals(
  source: string,
  file: string,
  manifestDir: string
): { signals: Signal[]; unknowns: UnknownRecord[] } {
  const masked = maskPython(source);
  const patterns: Array<{
    re: RegExp;
    confidence: Confidence;
    unhandled?: boolean;
  }> = [
    { re: /(?<![\w.])print(?![A-Za-z0-9_])(?!\s*\()/g, confidence: "high" },
    { re: /(?<![\w.])exec\s+(?!\()/g, confidence: "high", unhandled: true },
    { re: /(?<![\w.])unicode\s*\(/g, confidence: "medium" },
    { re: /\.(?:iteritems|iterkeys|itervalues)\s*\(/g, confidence: "medium" },
    { re: /<>/g, confidence: "high", unhandled: true },
    { re: /`[^`\r\n]*`?/g, confidence: "high", unhandled: true },
    { re: /except\s+[^:,\n()]+\s*,\s*[A-Za-z_]\w*\s*:/g, confidence: "high" },
    { re: /(?<!\.)\b0[0-9]+\b/g, confidence: "high", unhandled: true },
    {
      re: /(?<!\.)\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)[Ll]\b/g,
      confidence: "high",
      unhandled: true,
    },
    {
      re: /(?<![\w.])(?:def\s+[A-Za-z_]\w*\s*\([^()\n=]*|lambda\s+[^:\n=]*)\([^()\n]+\)/g,
      confidence: "high",
      unhandled: true,
    },
  ];
  const signals: Signal[] = [];
  const unknowns: UnknownRecord[] = [];

  for (const { re, confidence, unhandled } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked)) !== null) {
      const index = match.index;
      const { line, column } = lineColumnAt(source, index);
      signals.push({
        ruleId: "M1",
        file,
        line,
        column,
        matched: source.slice(index, index + match[0].length),
        confidence,
        manifestDir,
      });
      if (unhandled) {
        unknowns.push({
          ruleId: "M1",
          reason: "py2_residue",
          file,
          line,
        });
      }
      if (match[0].length >= 7 && /^unicode\s*\($/.test(match[0])) {
        const openParenIndex = index + match[0].length - 1;
        if (hasTopLevelCommaInCall(masked, openParenIndex)) {
          unknowns.push({
            ruleId: "M1",
            reason: "unicode_decoding_ambiguous",
            file,
            line,
          });
        }
      }
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }

  // Raw+unicode string prefixes (`ur"..."` / `ru"..."`) where quotes were masked.
  const urRe = /(?<![A-Za-z0-9_])(?:ur|ru)/gi;
  let urMatch: RegExpExecArray | null;
  while ((urMatch = urRe.exec(masked)) !== null) {
    const index = urMatch.index;
    const nextChar = source[index + urMatch[0].length];
    if (nextChar !== "'" && nextChar !== '"') continue;
    const { line, column } = lineColumnAt(source, index);
    signals.push({
      ruleId: "M1",
      file,
      line,
      column,
      matched: source.slice(index, index + urMatch[0].length + 1),
      confidence: "high",
      manifestDir,
    });
    unknowns.push({
      ruleId: "M1",
      reason: "py2_residue",
      file,
      line,
    });
  }

  // Python 2 `raise E, msg` (top-level comma outside call/bracketed expressions).
  const raiseRe = /(?<![\w.])raise\s+([^\n;#]+)/g;
  let raiseMatch: RegExpExecArray | null;
  while ((raiseMatch = raiseRe.exec(masked)) !== null) {
    const body = raiseMatch[1];
    const commaOffset = findTopLevelCommaIndex(body);
    if (commaOffset === -1) continue;
    const bodyStart = raiseMatch.index + raiseMatch[0].length - body.length;
    const afterCommaSource = source.slice(
      bodyStart + commaOffset + 1,
      bodyStart + body.length
    );
    if (!/\S/.test(afterCommaSource)) continue;
    const index = raiseMatch.index;
    const { line, column } = lineColumnAt(source, index);
    signals.push({
      ruleId: "M1",
      file,
      line,
      column,
      matched: source.slice(index, index + raiseMatch[0].length).trimEnd(),
      confidence: "high",
      manifestDir,
    });
    unknowns.push({
      ruleId: "M1",
      reason: "py2_residue",
      file,
      line,
    });
  }

  return { signals, unknowns };
}

const GLOBAL_PYTHON_PARSE_SYNC_KEY = "__ggPythonParseSync";

function collectPythonSignals(
  source: string,
  file: string,
  manifestDir: string,
  signals: Signal[],
  unknowns: UnknownRecord[]
): void {
  const parseSync = (globalThis as Record<string, unknown>)[
    GLOBAL_PYTHON_PARSE_SYNC_KEY
  ] as ((source: string, file: string) => PythonPlan | null) | undefined;
  if (typeof parseSync === "function") {
    const plan = parseSync(source, file);
    if (plan) {
      for (const item of plan.residue) {
        signals.push({
          ruleId: "M1",
          file,
          line: item.line,
          column: item.column,
          matched: item.text,
          confidence: residueConfidenceFor(item.kind),
          manifestDir,
        });
      }
      for (const unknown of plan.unknowns) unknowns.push(unknown);
      return;
    }
  }
  const fallback = lexicalPythonSignals(source, file, manifestDir);
  for (const signal of fallback.signals) signals.push(signal);
  for (const unknown of fallback.unknowns) unknowns.push(unknown);
}

export function detectSignals(
  input: DetectSignalsInput,
  options?: DetectSignalsOptions
): DetectSignalsResult {
  const rawList: DetectSignalsInputFile[] = toFileList(input);

  const signals: Signal[] = [];
  const unknowns: UnknownRecord[] = [];

  for (const file of rawList) {
    if (!file || typeof file.path !== "string") {
      continue;
    }

    const filePath = normalizePath(file.path);
    const isPython = isPythonFile(filePath);
    if (!isBabelParseable(filePath) && !isPython) {
      continue;
    }

    const manifestDir = getManifestDir(file);
    let source = file.content ?? file.text ?? (file as any).source;
    if (typeof source !== "string") {
      try {
        source = readFileSync(file.path, "utf-8");
      } catch {
        source = undefined;
      }
    }

    if (typeof source !== "string") {
      const errRecord: UnknownRecord = {
        ruleId: "",
        reason: "parse_error",
        file: filePath,
      };
      unknowns.push(errRecord);
      continue;
    }

    if (isPython) {
      collectPythonSignals(source, filePath, manifestDir, signals, unknowns);
      continue;
    }

    let ast: any;
    try {
      ast = parseSource(source, filePath);
    } catch (err: unknown) {
      const line =
        typeof err === "object" && err !== null && "loc" in err
          ? (err as any).loc?.line
          : undefined;
      const errRecord: UnknownRecord = {
        ruleId: "",
        reason: "parse_error",
        file: filePath,
        ...(line !== undefined ? { line } : {}),
      };
      unknowns.push(errRecord);
      continue;
    }

    walk(ast, (node: any) => {
      // 1. CallExpression
      if (node.type === "CallExpression") {
        // A) require(...)
        if (
          node.callee &&
          node.callee.type === "Identifier" &&
          node.callee.name === "require"
        ) {
          const loc = node.loc?.start;
          const line = loc?.line ?? 1;
          const column = loc?.column ?? 0;
          const matched =
            typeof node.start === "number" && typeof node.end === "number"
              ? source.slice(node.start, node.end)
              : "require(...)";

          const firstArg = node.arguments?.[0];
          const isStringArg = firstArg && firstArg.type === "StringLiteral";
          const argValue = isStringArg ? firstArg.value : undefined;

          // Check M2
          if (typeof argValue === "string" && isRequestPackage(argValue)) {
            signals.push({
              ruleId: "M2",
              file: filePath,
              line,
              column,
              matched,
              confidence: "high",
              manifestDir,
            });
            if (isRequestPromisePackage(argValue)) {
              unknowns.push({
                ruleId: "M2",
                reason: "request_promise_unsupported",
                file: filePath,
                line,
              });
            }
          }

          // Check M3
          signals.push({
            ruleId: "M3",
            file: filePath,
            line,
            column,
            matched,
            confidence: isStringArg ? "high" : "medium",
            manifestDir,
          });
        }
        // B) dynamic import(...) in older Babel AST
        else if (node.callee && node.callee.type === "Import") {
          const firstArg = node.arguments?.[0];
          if (firstArg && firstArg.type === "StringLiteral" && isRequestPackage(firstArg.value)) {
            const loc = node.loc?.start;
            const line = loc?.line ?? 1;
            const column = loc?.column ?? 0;
            const matched =
              typeof node.start === "number" && typeof node.end === "number"
                ? source.slice(node.start, node.end)
                : `import('${firstArg.value}')`;

            signals.push({
              ruleId: "M2",
              file: filePath,
              line,
              column,
              matched,
              confidence: "high",
              manifestDir,
            });
            if (isRequestPromisePackage(firstArg.value)) {
              unknowns.push({
                ruleId: "M2",
                reason: "request_promise_unsupported",
                file: filePath,
                line,
              });
            }
          }
        }
      }
      // 2. ImportExpression (dynamic import('request') in Babel 8)
      else if (node.type === "ImportExpression") {
        if (node.source && node.source.type === "StringLiteral" && isRequestPackage(node.source.value)) {
          const loc = node.loc?.start;
          const line = loc?.line ?? 1;
          const column = loc?.column ?? 0;
          const matched =
            typeof node.start === "number" && typeof node.end === "number"
              ? source.slice(node.start, node.end)
              : `import('${node.source.value}')`;

          signals.push({
            ruleId: "M2",
            file: filePath,
            line,
            column,
            matched,
            confidence: "high",
            manifestDir,
          });
          if (isRequestPromisePackage(node.source.value)) {
            unknowns.push({
              ruleId: "M2",
              reason: "request_promise_unsupported",
              file: filePath,
              line,
            });
          }
        }
      }
      // 3. ImportDeclaration
      else if (node.type === "ImportDeclaration") {
        if (node.source && isRequestPackage(node.source.value)) {
          const loc = node.loc?.start;
          const line = loc?.line ?? 1;
          const column = loc?.column ?? 0;
          const matched =
            typeof node.start === "number" && typeof node.end === "number"
              ? source.slice(node.start, node.end)
              : `import from '${node.source.value}'`;

          signals.push({
            ruleId: "M2",
            file: filePath,
            line,
            column,
            matched,
            confidence: "high",
            manifestDir,
          });
          if (isRequestPromisePackage(node.source.value)) {
            unknowns.push({
              ruleId: "M2",
              reason: "request_promise_unsupported",
              file: filePath,
              line,
            });
          }
        }
      }
      // 4. ExportNamedDeclaration / ExportAllDeclaration
      else if (
        (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        node.source &&
        isRequestPackage(node.source.value)
      ) {
        const loc = node.loc?.start;
        const line = loc?.line ?? 1;
        const column = loc?.column ?? 0;
        const matched =
          typeof node.start === "number" && typeof node.end === "number"
            ? source.slice(node.start, node.end)
            : `export from '${node.source.value}'`;

        signals.push({
          ruleId: "M2",
          file: filePath,
          line,
          column,
          matched,
          confidence: "high",
          manifestDir,
        });
        if (isRequestPromisePackage(node.source.value)) {
          unknowns.push({
            ruleId: "M2",
            reason: "request_promise_unsupported",
            file: filePath,
            line,
          });
        }
      }
      // 5. MemberExpression: module.exports
      else if (node.type === "MemberExpression") {
        const isModule =
          node.object && node.object.type === "Identifier" && node.object.name === "module";
        const isExports =
          (!node.computed &&
            node.property &&
            node.property.type === "Identifier" &&
            node.property.name === "exports") ||
          (node.computed &&
            node.property &&
            node.property.type === "StringLiteral" &&
            node.property.value === "exports");

        if (isModule && isExports) {
          const loc = node.loc?.start;
          const line = loc?.line ?? 1;
          const column = loc?.column ?? 0;
          const matched =
            typeof node.start === "number" && typeof node.end === "number"
              ? source.slice(node.start, node.end)
              : "module.exports";

          signals.push({
            ruleId: "M3",
            file: filePath,
            line,
            column,
            matched,
            confidence: "high",
            manifestDir,
          });
        }
      }
      // 6. Identifier: CommonsChunkPlugin
      else if (node.type === "Identifier" && node.name === "CommonsChunkPlugin") {
        const loc = node.loc?.start;
        const line = loc?.line ?? 1;
        const column = loc?.column ?? 0;
        const matched =
          typeof node.start === "number" && typeof node.end === "number"
            ? source.slice(node.start, node.end)
            : "CommonsChunkPlugin";

        signals.push({
          ruleId: "M4",
          file: filePath,
          line,
          column,
          matched,
          confidence: "high",
          manifestDir,
        });
      }
    });
  }

  return finalizeSignals(signals, unknowns, options);
}

/**
 * Synchronous Python-only detector that always uses the comment/string-aware
 * lexical fallback (no tree-sitter dependency). Deterministic entry point for
 * the fallback path used by `detectSignals` before the parser is initialized.
 */
export function detectPythonSignalsLexical(
  input: DetectSignalsInput,
  options?: DetectSignalsOptions
): DetectSignalsResult {
  const rawList = toFileList(input);
  const signals: Signal[] = [];
  const unknowns: UnknownRecord[] = [];

  for (const file of rawList) {
    if (!file || typeof file.path !== "string") continue;

    const filePath = normalizePath(file.path);
    if (!isPythonFile(filePath)) continue;

    const manifestDir = getManifestDir(file);
    let source = file.content ?? file.text ?? (file as any).source;
    if (typeof source !== "string") {
      try {
        source = readFileSync(file.path, "utf-8");
      } catch {
        source = undefined;
      }
    }
    if (typeof source !== "string") {
      unknowns.push({ ruleId: "M1", reason: "parse_error", file: filePath });
      continue;
    }

    const fallback = lexicalPythonSignals(source, filePath, manifestDir);
    for (const signal of fallback.signals) signals.push(signal);
    for (const unknown of fallback.unknowns) unknowns.push(unknown);
  }

  return finalizeSignals(signals, unknowns, options);
}

/**
 * Asynchronous Python-only detector. Uses the tree-sitter analyzer so comments
 * and string literals are suppressed automatically.
 */
export async function detectPythonSignals(
  input: DetectSignalsInput,
  options?: DetectSignalsOptions
): Promise<DetectSignalsResult> {
  const { initPythonParser, planPythonEdits } = await import("../rules/m1-python");
  await initPythonParser();

  const rawList = toFileList(input);
  const signals: Signal[] = [];
  const unknowns: UnknownRecord[] = [];

  for (const file of rawList) {
    if (!file || typeof file.path !== "string") continue;

    const filePath = normalizePath(file.path);
    if (!isPythonFile(filePath)) continue;

    const manifestDir = getManifestDir(file);
    let source = file.content ?? file.text ?? (file as any).source;
    if (typeof source !== "string") {
      try {
        source = readFileSync(file.path, "utf-8");
      } catch {
        source = undefined;
      }
    }

    if (typeof source !== "string") {
      unknowns.push({ ruleId: "M1", reason: "parse_error", file: filePath });
      continue;
    }

    const plan = planPythonEdits(source, filePath);
    if (!plan) {
      unknowns.push({ ruleId: "M1", reason: "parse_error", file: filePath });
      continue;
    }
    for (const item of plan.residue) {
      signals.push({
        ruleId: "M1",
        file: filePath,
        line: item.line,
        column: item.column,
        matched: item.text,
        confidence: residueConfidenceFor(item.kind),
        manifestDir,
      });
    }
    for (const unknown of plan.unknowns) unknowns.push(unknown);
  }

  return finalizeSignals(signals, unknowns, options);
}

