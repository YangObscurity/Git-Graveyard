import * as path from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import * as Diff from "diff";
import type { Signal, UnknownRecord, RuleId, Confidence } from "../grimoire/types";

// Requirement 7.1, 7.3 - 7.6, 7.16
// ALLOWED_KEYS: The set of request option keys supported by the Request_Adapter
export const ALLOWED_KEYS = [
  "url",
  "uri",
  "method",
  "headers",
  "body",
  "json",
  "qs",
  "timeout",
  "followRedirect",
] as const;

export type AllowedKey = (typeof ALLOWED_KEYS)[number];

// Eligible call site verbs from requirements.md Glossary
export const ALLOWED_VERBS = [
  "get",
  "post",
  "put",
  "patch",
  "del",
  "head",
] as const;

export type AllowedVerb = (typeof ALLOWED_VERBS)[number];

export const REQUEST_PACKAGES = ["request"] as const;

export const REQUEST_PROMISE_PACKAGES = [
  "request-promise",
  "request-promise-native",
  "request-promise-any",
] as const;

export interface TaggedImport {
  ruleId: "M2";
  type: "require" | "import" | "dynamic_import";
  name: string;
  quote: string;
  raw: string;
  start: number;
  end: number;
  line: number;
  column: number;
  file?: string;
  isPromise: boolean;
  bindingName?: string;
}

export interface PlannedEdit {
  start: number;
  end: number;
  text: string;
  replacement: string;
  ruleId: "M2";
  file?: string;
  description?: string;
}

export interface CallSiteInfo {
  line: number;
  column: number;
  callee: string;
  verb?: string;
  optsKeys: string[];
  hasCallback: boolean;
  returnValueUnused: boolean;
  eligible: boolean;
  reason?: string;
}

export interface PatchStep {
  id: string;
  ruleId: "M2";
  file: string;
  diff: string;
  diffOmitted?: true;
  hunks: number;
  compat: boolean;
  behavior: "unknown";
  notes?: string;
  confidence: "high" | "medium";
  reverted: boolean;
  revertReason?: "parse_failed" | "all_edits_rejected";
}

export interface M2TransformOptions {
  filePath?: string;
  manifestDir?: string;
  adapterSpecifier?: string;
  adapterPath?: string;
  adapterFileName?: string;
}

export interface M2TransformResult {
  code: string;
  changed: boolean;
  plannedEdits: PlannedEdit[];
  edits: PlannedEdit[];
  unknownRecords: UnknownRecord[];
  unknowns: UnknownRecord[];
  tags: TaggedImport[];
  signals: Signal[];
  callSites: CallSiteInfo[];
  eligible: boolean;
  step?: PatchStep;
}

function normalizePath(filePath: string): string {
  if (typeof filePath !== "string") return "";
  let p = filePath.replace(/\\/g, "/");
  p = p.replace(/^\.?\/+/, "");
  p = p.replace(/\/+/g, "/");
  return p.replace(/\/+$/, "");
}

function isEligibleExtension(filePath?: string): boolean {
  if (!filePath || typeof filePath !== "string") {
    return true;
  }
  const norm = normalizePath(filePath).toLowerCase();
  const basename = norm.slice(norm.lastIndexOf("/") + 1);
  return (
    basename.endsWith(".js") ||
    basename.endsWith(".cjs") ||
    basename.endsWith(".mjs") ||
    basename.endsWith(".jsx")
  );
}

function isRequestPackage(name: string): boolean {
  if (typeof name !== "string") return false;
  return name === "request" || name.startsWith("request/");
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

function isAnyRequestPackage(name: string): boolean {
  return isRequestPackage(name) || isRequestPromisePackage(name);
}

function computeAdapterSpecifier(
  filePath: string | undefined,
  manifestDir: string | undefined,
  adapterPathOption: string | undefined,
  adapterSpecifierOption: string | undefined,
  adapterFileName = "request-compat.cjs"
): string {
  if (adapterSpecifierOption) {
    return adapterSpecifierOption;
  }
  if (!filePath) {
    return `./${adapterFileName}`;
  }
  const normFile = normalizePath(filePath);
  const fileDir = path.posix.dirname(normFile);
  const mDir = normalizePath(manifestDir || ".");
  const targetAdapter = adapterPathOption
    ? normalizePath(adapterPathOption)
    : path.posix.join(mDir, adapterFileName);

  let rel = path.posix.relative(fileDir, targetAdapter);
  if (!rel.startsWith(".")) {
    rel = "./" + rel;
  }
  return rel;
}

function formatQuotedSpecifier(specifier: string, originalRaw?: string): string {
  const quote = originalRaw ? originalRaw.trim()[0] : "'";
  if (quote === '"') {
    return `"${specifier}"`;
  }
  if (quote === "`") {
    return `\`${specifier}\``;
  }
  return `'${specifier}'`;
}

function parseSourceAst(source: string, filePath?: string): any {
  const norm = filePath ? normalizePath(filePath).toLowerCase() : "source.js";
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
    ["typescript", "jsx", "decorators-legacy"],
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

function applyEdits(source: string, edits: PlannedEdit[]): string {
  if (edits.length === 0) return source;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let res = source;
  for (const edit of sorted) {
    const textToInsert = edit.text ?? edit.replacement;
    res = res.slice(0, edit.start) + textToInsert + res.slice(edit.end);
  }
  return res;
}

function isShadowed(name: string, scopeStack: Set<string>[]): boolean {
  for (let i = scopeStack.length - 1; i > 0; i--) {
    if (scopeStack[i].has(name)) {
      return true;
    }
  }
  return false;
}

function extractIdentifiers(node: any, targetSet: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "Identifier" && typeof node.name === "string") {
    targetSet.add(node.name);
    return;
  }
  if (node.type === "AssignmentPattern") {
    extractIdentifiers(node.left, targetSet);
    return;
  }
  if (node.type === "RestElement") {
    extractIdentifiers(node.argument, targetSet);
    return;
  }
  if (node.type === "ArrayPattern") {
    for (const el of node.elements) {
      if (el) extractIdentifiers(el, targetSet);
    }
    return;
  }
  if (node.type === "ObjectPattern") {
    for (const prop of node.properties) {
      if (!prop) continue;
      if (prop.type === "ObjectProperty") {
        extractIdentifiers(prop.value, targetSet);
      } else if (prop.type === "RestElement") {
        extractIdentifiers(prop.argument, targetSet);
      }
    }
    return;
  }
}

/**
 * M2 request migration transform.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 *
 * Pure transform on source text, using @babel/parser.
 * Tags require('request'), require("request"), import request from 'request'
 * and imports of request-promise, request-promise-native, request-promise-any.
 * A request-promise import is flagged unknown with reason request_promise_unsupported and is not edited.
 * A call site is eligible when it matches the Eligible_Call_Site definition in requirements.md Glossary.
 * When every call site in a file is eligible, the file's request specifier is rewritten to point at
 * the adapter, and the step is marked compat true and behavior unknown.
 * The transform returns the planned edits and the unknown records. It never writes to disk.
 */
export function transformM2Request(
  source: string,
  options?: M2TransformOptions
): M2TransformResult {
  const filePath = options?.filePath || "source.js";
  const manifestDir = options?.manifestDir || ".";
  const tags: TaggedImport[] = [];
  const signals: Signal[] = [];
  const unknownRecords: UnknownRecord[] = [];
  const callSites: CallSiteInfo[] = [];

  let ast: any;
  try {
    ast = parseSourceAst(source, filePath);
  } catch (err: any) {
    const line = err && typeof err === "object" && err.loc?.line ? err.loc.line : 1;
    const unparseableRecord: UnknownRecord = {
      ruleId: "M2",
      reason: "original_unparseable",
      file: filePath,
      line,
    };
    return {
      code: source,
      changed: false,
      plannedEdits: [],
      edits: [],
      unknownRecords: [unparseableRecord],
      unknowns: [unparseableRecord],
      tags: [],
      signals: [],
      callSites: [],
      eligible: false,
    };
  }

  interface SpecifierNode {
    start: number;
    end: number;
    raw: string;
    quote: string;
    line: number;
    column: number;
  }

  const specifierNodes: SpecifierNode[] = [];
  const bindingNames = new Set<string>();
  let hasPromiseImport = false;
  let hasDestructuring = false;
  const destructuringLines: number[] = [];

  // Phase 1: Traverse and collect imports / require declarations
  function scanImports(node: any, parent: any, grandparent: any): void {
    if (!node || typeof node !== "object") return;

    // 1. require(...)
    if (
      node.type === "CallExpression" &&
      node.callee &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      const firstArg = node.arguments?.[0];
      if (firstArg && firstArg.type === "StringLiteral" && isAnyRequestPackage(firstArg.value)) {
        const val = firstArg.value;
        const line = node.loc?.start.line ?? 1;
        const column = node.loc?.start.column ?? 0;
        const raw = source.slice(node.start, node.end);
        const argRaw = source.slice(firstArg.start, firstArg.end);
        const quote = argRaw.trim()[0] || "'";
        const isPromise = isRequestPromisePackage(val);

        tags.push({
          ruleId: "M2",
          type: "require",
          name: val,
          quote,
          raw,
          start: node.start,
          end: node.end,
          line,
          column,
          file: filePath,
          isPromise,
        });

        signals.push({
          ruleId: "M2",
          file: filePath,
          line,
          column,
          matched: raw,
          confidence: "high",
          manifestDir,
        });

        if (isPromise) {
          hasPromiseImport = true;
          unknownRecords.push({
            ruleId: "M2",
            reason: "request_promise_unsupported",
            file: filePath,
            line,
          });
        } else {
          specifierNodes.push({
            start: firstArg.start,
            end: firstArg.end,
            raw: argRaw,
            quote,
            line,
            column,
          });

          // Determine binding name
          if (parent && parent.type === "VariableDeclarator" && parent.init === node) {
            if (parent.id.type === "Identifier") {
              bindingNames.add(parent.id.name);
            } else if (parent.id.type === "ObjectPattern") {
              hasDestructuring = true;
              destructuringLines.push(parent.loc?.start.line ?? line);
            }
          } else if (parent && parent.type === "MemberExpression" && parent.object === node) {
            if (grandparent && grandparent.type === "VariableDeclarator" && grandparent.id.type === "Identifier") {
              bindingNames.add(grandparent.id.name);
            }
          } else {
            bindingNames.add("request");
          }
        }
      }
    }

    // 2. ImportDeclaration
    if (node.type === "ImportDeclaration" && node.source && isAnyRequestPackage(node.source.value)) {
      const val = node.source.value;
      const line = node.loc?.start.line ?? 1;
      const column = node.loc?.start.column ?? 0;
      const raw = source.slice(node.start, node.end);
      const sourceRaw = source.slice(node.source.start, node.source.end);
      const quote = sourceRaw.trim()[0] || "'";
      const isPromise = isRequestPromisePackage(val);

      tags.push({
        ruleId: "M2",
        type: "import",
        name: val,
        quote,
        raw,
        start: node.start,
        end: node.end,
        line,
        column,
        file: filePath,
        isPromise,
      });

      signals.push({
        ruleId: "M2",
        file: filePath,
        line,
        column,
        matched: raw,
        confidence: "high",
        manifestDir,
      });

      if (isPromise) {
        hasPromiseImport = true;
        unknownRecords.push({
          ruleId: "M2",
          reason: "request_promise_unsupported",
          file: filePath,
          line,
        });
      } else {
        specifierNodes.push({
          start: node.source.start,
          end: node.source.end,
          raw: sourceRaw,
          quote,
          line,
          column,
        });

        if (Array.isArray(node.specifiers)) {
          for (const spec of node.specifiers) {
            if (spec.type === "ImportDefaultSpecifier" && spec.local?.type === "Identifier") {
              bindingNames.add(spec.local.name);
            } else if (spec.type === "ImportNamespaceSpecifier" && spec.local?.type === "Identifier") {
              bindingNames.add(spec.local.name);
            } else if (spec.type === "ImportSpecifier") {
              hasDestructuring = true;
              destructuringLines.push(spec.loc?.start.line ?? line);
            }
          }
        }
        if (bindingNames.size === 0) {
          bindingNames.add("request");
        }
      }
    }

    // 3. Dynamic import(...)
    if (
      (node.type === "ImportExpression" && node.source && node.source.type === "StringLiteral" && isAnyRequestPackage(node.source.value)) ||
      (node.type === "CallExpression" && node.callee && node.callee.type === "Import" && node.arguments?.[0]?.type === "StringLiteral" && isAnyRequestPackage(node.arguments[0].value))
    ) {
      const srcNode = node.type === "ImportExpression" ? node.source : node.arguments[0];
      const val = srcNode.value;
      const line = node.loc?.start.line ?? 1;
      const column = node.loc?.start.column ?? 0;
      const raw = source.slice(node.start, node.end);
      const srcRaw = source.slice(srcNode.start, srcNode.end);
      const quote = srcRaw.trim()[0] || "'";
      const isPromise = isRequestPromisePackage(val);

      tags.push({
        ruleId: "M2",
        type: "dynamic_import",
        name: val,
        quote,
        raw,
        start: node.start,
        end: node.end,
        line,
        column,
        file: filePath,
        isPromise,
      });

      signals.push({
        ruleId: "M2",
        file: filePath,
        line,
        column,
        matched: raw,
        confidence: "high",
        manifestDir,
      });

      if (isPromise) {
        hasPromiseImport = true;
        unknownRecords.push({
          ruleId: "M2",
          reason: "request_promise_unsupported",
          file: filePath,
          line,
        });
      } else {
        specifierNodes.push({
          start: srcNode.start,
          end: srcNode.end,
          raw: srcRaw,
          quote,
          line,
          column,
        });
        bindingNames.add("request");
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") {
        continue;
      }
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          scanImports(item, node, parent);
        }
      } else if (val && typeof val === "object") {
        scanImports(val, node, parent);
      }
    }
  }

  scanImports(ast, null, null);

  if (bindingNames.size === 0) {
    bindingNames.add("request");
  }

  let allEligible = true;

  if (hasDestructuring) {
    allEligible = false;
    for (const line of destructuringLines) {
      unknownRecords.push({
        ruleId: "M2",
        reason: "request_unsupported_call",
        file: filePath,
        line,
      });
    }
  }

  // Phase 2: Traverse call sites and binding usages with scope tracking
  const scopeStack: Set<string>[] = [new Set<string>()];

  function validateCallSite(node: any, parent: any, grandparent: any): void {
    if (!node || typeof node !== "object") return;

    let pushedScope = false;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const fnScope = new Set<string>();
      if (Array.isArray(node.params)) {
        for (const param of node.params) {
          extractIdentifiers(param, fnScope);
        }
      }
      scopeStack.push(fnScope);
      pushedScope = true;
    } else if (node.type === "BlockStatement") {
      const blockScope = new Set<string>();
      if (Array.isArray(node.body)) {
        for (const stmt of node.body) {
          if (stmt && stmt.type === "VariableDeclaration" && stmt.kind !== "var") {
            for (const decl of stmt.declarations) {
              extractIdentifiers(decl.id, blockScope);
            }
          }
        }
      }
      scopeStack.push(blockScope);
      pushedScope = true;
    }

    // Check CallExpression
    if (node.type === "CallExpression") {
      const line = node.loc?.start.line ?? 1;
      const column = node.loc?.start.column ?? 0;

      // Form A: request(opts, cb)
      if (
        node.callee &&
        node.callee.type === "Identifier" &&
        bindingNames.has(node.callee.name) &&
        !isShadowed(node.callee.name, scopeStack)
      ) {
        const calleeStr = node.callee.name;
        let siteEligible = true;
        let reason: string | undefined;

        // 1. File extension
        if (!isEligibleExtension(filePath)) {
          siteEligible = false;
          reason = "request_unsupported_call";
        }

        // 2. opts argument
        const firstArg = node.arguments?.[0];
        const optsKeys: string[] = [];
        if (!firstArg || firstArg.type !== "ObjectExpression") {
          siteEligible = false;
          reason = "request_unsupported_call";
        } else {
          for (const prop of firstArg.properties) {
            if (prop.type !== "ObjectProperty" || prop.computed) {
              siteEligible = false;
              reason = "request_unsupported_call";
              break;
            }
            let keyName: string | undefined;
            if (prop.key.type === "Identifier") {
              keyName = prop.key.name;
            } else if (prop.key.type === "StringLiteral") {
              keyName = prop.key.value;
            }
            if (!keyName || !ALLOWED_KEYS.includes(keyName as AllowedKey)) {
              siteEligible = false;
              reason = "request_unsupported_call";
              break;
            }
            optsKeys.push(keyName);
          }
        }

        // 3. cb argument
        const secondArg = node.arguments?.[1];
        const hasCallback = Boolean(secondArg);
        if (!hasCallback) {
          siteEligible = false;
          reason = "request_unsupported_call";
        }

        // 4. Return value unused
        const isExpressionStatement = Boolean(parent && parent.type === "ExpressionStatement");
        const isVoidInExpressionStatement = Boolean(
          parent &&
          parent.type === "UnaryExpression" &&
          parent.operator === "void" &&
          grandparent &&
          grandparent.type === "ExpressionStatement"
        );
        const returnValueUnused = isExpressionStatement || isVoidInExpressionStatement;
        if (!returnValueUnused) {
          siteEligible = false;
          reason = "request_unsupported_call";
        }

        callSites.push({
          line,
          column,
          callee: calleeStr,
          optsKeys,
          hasCallback,
          returnValueUnused,
          eligible: siteEligible,
          reason,
        });

        if (!siteEligible) {
          allEligible = false;
          unknownRecords.push({
            ruleId: "M2",
            reason: reason || "request_unsupported_call",
            file: filePath,
            line,
          });
        }
      }
      // Form B: request.<verb>(opts, cb) or unsupported method call
      else if (
        node.callee &&
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object &&
        node.callee.object.type === "Identifier" &&
        bindingNames.has(node.callee.object.name) &&
        !isShadowed(node.callee.object.name, scopeStack)
      ) {
        const objName = node.callee.object.name;
        const verbName = node.callee.property?.type === "Identifier" ? node.callee.property.name : undefined;
        const calleeStr = `${objName}.${verbName || "unknown"}`;
        const isAllowedVerb = verbName ? ALLOWED_VERBS.includes(verbName as AllowedVerb) : false;

        if (!isAllowedVerb) {
          allEligible = false;
          callSites.push({
            line,
            column,
            callee: calleeStr,
            verb: verbName,
            optsKeys: [],
            hasCallback: false,
            returnValueUnused: false,
            eligible: false,
            reason: "request_unsupported_call",
          });
          unknownRecords.push({
            ruleId: "M2",
            reason: "request_unsupported_call",
            file: filePath,
            line,
          });
        } else {
          let siteEligible = true;
          let reason: string | undefined;

          // 1. File extension
          if (!isEligibleExtension(filePath)) {
            siteEligible = false;
            reason = "request_unsupported_call";
          }

          // 2. opts argument
          const firstArg = node.arguments?.[0];
          const optsKeys: string[] = [];
          if (!firstArg || firstArg.type !== "ObjectExpression") {
            siteEligible = false;
            reason = "request_unsupported_call";
          } else {
            for (const prop of firstArg.properties) {
              if (prop.type !== "ObjectProperty" || prop.computed) {
                siteEligible = false;
                reason = "request_unsupported_call";
                break;
              }
              let keyName: string | undefined;
              if (prop.key.type === "Identifier") {
                keyName = prop.key.name;
              } else if (prop.key.type === "StringLiteral") {
                keyName = prop.key.value;
              }
              if (!keyName || !ALLOWED_KEYS.includes(keyName as AllowedKey)) {
                siteEligible = false;
                reason = "request_unsupported_call";
                break;
              }
              optsKeys.push(keyName);
            }
          }

          // 3. cb argument
          const secondArg = node.arguments?.[1];
          const hasCallback = Boolean(secondArg);
          if (!hasCallback) {
            siteEligible = false;
            reason = "request_unsupported_call";
          }

          // 4. Return value unused
          const isExpressionStatement = Boolean(parent && parent.type === "ExpressionStatement");
          const isVoidInExpressionStatement = Boolean(
            parent &&
            parent.type === "UnaryExpression" &&
            parent.operator === "void" &&
            grandparent &&
            grandparent.type === "ExpressionStatement"
          );
          const returnValueUnused = isExpressionStatement || isVoidInExpressionStatement;
          if (!returnValueUnused) {
            siteEligible = false;
            reason = "request_unsupported_call";
          }

          callSites.push({
            line,
            column,
            callee: calleeStr,
            verb: verbName,
            optsKeys,
            hasCallback,
            returnValueUnused,
            eligible: siteEligible,
            reason,
          });

          if (!siteEligible) {
            allEligible = false;
            unknownRecords.push({
              ruleId: "M2",
              reason: reason || "request_unsupported_call",
              file: filePath,
              line,
            });
          }
        }
      }
    }
    // Check non-call identifier usages of the binding
    else if (
      node.type === "Identifier" &&
      bindingNames.has(node.name) &&
      !isShadowed(node.name, scopeStack)
    ) {
      const isDeclaration =
        (parent && parent.type === "VariableDeclarator" && parent.id === node) ||
        (parent && parent.type === "ImportDefaultSpecifier" && parent.local === node) ||
        (parent && parent.type === "ImportNamespaceSpecifier" && parent.local === node);

      const isCallCallee = parent && parent.type === "CallExpression" && parent.callee === node;

      const isMemberObjectOfCall =
        parent &&
        parent.type === "MemberExpression" &&
        parent.object === node &&
        grandparent &&
        grandparent.type === "CallExpression" &&
        grandparent.callee === parent;

      if (!isDeclaration && !isCallCallee && !isMemberObjectOfCall) {
        allEligible = false;
        unknownRecords.push({
          ruleId: "M2",
          reason: "request_unsupported_call",
          file: filePath,
          line: node.loc?.start.line ?? 1,
        });
      }
    }

    // Traverse children
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") {
        continue;
      }
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          validateCallSite(item, node, parent);
        }
      } else if (val && typeof val === "object") {
        validateCallSite(val, node, parent);
      }
    }

    if (pushedScope) {
      scopeStack.pop();
    }
  }

  validateCallSite(ast, null, null);

  // Deduplicate unknown records by (reason, file, line)
  const uniqueUnknowns: UnknownRecord[] = [];
  const seenUnknowns = new Set<string>();
  for (const rec of unknownRecords) {
    const key = `${rec.reason}:${rec.file || ""}:${rec.line ?? ""}`;
    if (!seenUnknowns.has(key)) {
      seenUnknowns.add(key);
      uniqueUnknowns.push(rec);
    }
  }

  // If there are no request imports or requires in this file
  if (specifierNodes.length === 0) {
    return {
      code: source,
      changed: false,
      plannedEdits: [],
      edits: [],
      unknownRecords: uniqueUnknowns,
      unknowns: uniqueUnknowns,
      tags,
      signals,
      callSites,
      eligible: allEligible,
    };
  }

  // If request-promise is imported, or if any call site is ineligible: make no edits
  if (hasPromiseImport || !allEligible) {
    return {
      code: source,
      changed: false,
      plannedEdits: [],
      edits: [],
      unknownRecords: uniqueUnknowns,
      unknowns: uniqueUnknowns,
      tags,
      signals,
      callSites,
      eligible: false,
    };
  }

  // Every call site is eligible: rewrite request specifier to point at adapter
  const adapterSpecifier = computeAdapterSpecifier(
    filePath,
    manifestDir,
    options?.adapterPath,
    options?.adapterSpecifier,
    options?.adapterFileName
  );

  const plannedEdits: PlannedEdit[] = [];
  for (const specNode of specifierNodes) {
    const replacement = formatQuotedSpecifier(adapterSpecifier, specNode.raw);
    plannedEdits.push({
      start: specNode.start,
      end: specNode.end,
      text: replacement,
      replacement,
      ruleId: "M2",
      file: filePath,
      description: "Rewrite request specifier to request-compat adapter",
    });
  }

  const newCode = applyEdits(source, plannedEdits);
  const changed = plannedEdits.length > 0;

  let step: PatchStep | undefined;
  if (changed) {
    const patch = Diff.createPatch(filePath, source, newCode, "", "", { context: 3 });
    const hunks = (patch.match(/^@@/gm) || []).length;
    step = {
      id: `M2:${filePath}`,
      ruleId: "M2",
      file: filePath,
      diff: patch,
      hunks,
      compat: true,
      behavior: "unknown",
      notes: "transport is fetch; only the R1 adapter behaviors are kept",
      confidence: "high",
      reverted: false,
    };
  }

  return {
    code: newCode,
    changed,
    plannedEdits,
    edits: plannedEdits,
    unknownRecords: uniqueUnknowns,
    unknowns: uniqueUnknowns,
    tags,
    signals,
    callSites,
    eligible: true,
    step,
  };
}

// Aliases and helpers
export const m2RequestTransform = transformM2Request;
export const transform = transformM2Request;

export function scanM2Imports(
  source: string,
  options?: M2TransformOptions
): TaggedImport[] {
  return transformM2Request(source, options).tags;
}

export function scanCallSites(
  source: string,
  options?: M2TransformOptions
): { callSites: CallSiteInfo[]; unknowns: UnknownRecord[] } {
  const res = transformM2Request(source, options);
  return {
    callSites: res.callSites,
    unknowns: res.unknownRecords,
  };
}

export function isEligibleCallSite(
  node: unknown,
  source: string,
  options?: M2TransformOptions
): boolean {
  if (typeof node === "string") {
    const res = transformM2Request(node, options);
    return res.eligible && res.callSites.length > 0 && res.callSites.every((c) => c.eligible);
  }
  const res = transformM2Request(source, options);
  return res.callSites.length > 0 && res.callSites.every((c) => c.eligible);
}

export default transformM2Request;
