import { execSync } from "node:child_process";
import { parse, type ParserPlugin } from "@babel/parser";
import type { UnknownRecord } from "../grimoire/types";

export type PackageKind =
  | "esm"
  | "monorepo"
  | "application"
  | "library"
  | "unknown";

export type Requirement81Kind =
  | "already ESM"
  | "unknown"
  | "application"
  | "library";

export interface PackageClassification {
  kind: PackageKind;
  requirement81Kind: Requirement81Kind;
  isEsm: boolean;
  isMonorepo: boolean;
  isApplication: boolean;
  isLibrary: boolean;
  isUnknown: boolean;
  leaveInCommonJS: boolean;
  canConvert: boolean;
  reference?: "U4";
  reason?: string;
  unknowns: UnknownRecord[];
  toString(): string;
  valueOf(): string;
  [Symbol.toPrimitive](hint: string): string;
}

export type PackageJsonInput =
  | Record<string, unknown>
  | string
  | null
  | undefined;

function createClassification(data: {
  kind: PackageKind;
  requirement81Kind: Requirement81Kind;
  isEsm?: boolean;
  isMonorepo?: boolean;
  isApplication?: boolean;
  isLibrary?: boolean;
  isUnknown?: boolean;
  leaveInCommonJS: boolean;
  canConvert: boolean;
  reference?: "U4";
  reason?: string;
  unknowns: UnknownRecord[];
}): PackageClassification {
  return {
    kind: data.kind,
    requirement81Kind: data.requirement81Kind,
    isEsm: data.isEsm ?? false,
    isMonorepo: data.isMonorepo ?? false,
    isApplication: data.isApplication ?? false,
    isLibrary: data.isLibrary ?? false,
    isUnknown: data.isUnknown ?? false,
    leaveInCommonJS: data.leaveInCommonJS,
    canConvert: data.canConvert,
    reference: data.reference,
    reason: data.reason,
    unknowns: data.unknowns,
    toString() {
      return data.kind;
    },
    valueOf() {
      return data.kind;
    },
    [Symbol.toPrimitive]() {
      return data.kind;
    },
  };
}

/**
 * Requirement 8.1 Truth Table:
 * 1. already ESM when type is module
 * 2. unknown when workspaces is set
 * 3. application when private is true
 * 4. library when private is not true, any of exports, main or module is set and scripts.start is not a string
 * 5. application when private is not true, none of exports, main or module is set, and scripts.start is a string or bin is set
 * 6. unknown otherwise
 *
 * Requirement 8.2:
 * IF a package is classified as library or unknown, THEN THE Grimoire SHALL leave the package in CommonJS
 * and record unknown with reference U4.
 */
export function classifyPackage(
  pkgInput: PackageJsonInput,
  options?: { filePath?: string }
): PackageClassification {
  const filePath = options?.filePath || "package.json";
  let pkg: Record<string, unknown> | null = null;

  if (typeof pkgInput === "string") {
    try {
      pkg = JSON.parse(pkgInput);
    } catch {
      pkg = null;
    }
  } else if (
    pkgInput &&
    typeof pkgInput === "object" &&
    !Array.isArray(pkgInput)
  ) {
    pkg = pkgInput as Record<string, unknown>;
  }

  if (!pkg) {
    const unknownRecord: UnknownRecord = {
      ruleId: "M3",
      reason: "U4",
      file: filePath,
    };
    return createClassification({
      kind: "unknown",
      requirement81Kind: "unknown",
      isUnknown: true,
      leaveInCommonJS: true,
      canConvert: false,
      reference: "U4",
      reason: "unparseable_package_json",
      unknowns: [unknownRecord],
    });
  }

  // 1. already ESM when type is module
  if (pkg.type === "module") {
    return createClassification({
      kind: "esm",
      requirement81Kind: "already ESM",
      isEsm: true,
      leaveInCommonJS: false,
      canConvert: false,
      unknowns: [],
    });
  }

  // 2. unknown when workspaces is set
  if (pkg.workspaces !== undefined && pkg.workspaces !== null) {
    const u4: UnknownRecord = {
      ruleId: "M3",
      reason: "U4",
      file: filePath,
    };
    return createClassification({
      kind: "monorepo",
      requirement81Kind: "unknown",
      isMonorepo: true,
      isUnknown: true,
      leaveInCommonJS: true,
      canConvert: false,
      reference: "U4",
      reason: "monorepo_workspace",
      unknowns: [u4],
    });
  }

  // 3. application when private is true
  if (pkg.private === true) {
    return createClassification({
      kind: "application",
      requirement81Kind: "application",
      isApplication: true,
      leaveInCommonJS: false,
      canConvert: true,
      unknowns: [],
    });
  }

  // Helper checks for 4 and 5
  const hasExports = pkg.exports !== undefined && pkg.exports !== null;
  const hasMain = typeof pkg.main === "string" && pkg.main.trim().length > 0;
  const hasModule =
    typeof pkg.module === "string" && pkg.module.trim().length > 0;
  const anyExportsMainOrModule = hasExports || hasMain || hasModule;

  const scripts =
    pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : undefined;
  const scriptsStartIsString = typeof scripts?.start === "string";

  // 4. library when private is not true, any of exports, main or module is set and scripts.start is not a string
  if (pkg.private !== true && anyExportsMainOrModule && !scriptsStartIsString) {
    const u4: UnknownRecord = {
      ruleId: "M3",
      reason: "U4",
      file: filePath,
    };
    return createClassification({
      kind: "library",
      requirement81Kind: "library",
      isLibrary: true,
      leaveInCommonJS: true,
      canConvert: false,
      reference: "U4",
      reason: "library",
      unknowns: [u4],
    });
  }

  // 5. application when private is not true, none of exports, main or module is set, and scripts.start is a string or bin is set
  const binIsSet = pkg.bin !== undefined && pkg.bin !== null;
  if (
    pkg.private !== true &&
    !anyExportsMainOrModule &&
    (scriptsStartIsString || binIsSet)
  ) {
    return createClassification({
      kind: "application",
      requirement81Kind: "application",
      isApplication: true,
      leaveInCommonJS: false,
      canConvert: true,
      unknowns: [],
    });
  }

  // 6. unknown otherwise
  const u4: UnknownRecord = {
    ruleId: "M3",
    reason: "U4",
    file: filePath,
  };
  return createClassification({
    kind: "unknown",
    requirement81Kind: "unknown",
    isUnknown: true,
    leaveInCommonJS: true,
    canConvert: false,
    reference: "U4",
    reason: "unknown",
    unknowns: [u4],
  });
}

export function classifyPackageJson(
  pkgInput: PackageJsonInput,
  options?: { filePath?: string }
): PackageClassification {
  return classifyPackage(pkgInput, options);
}

export function getPackageKind(
  pkgInput: PackageJsonInput,
  options?: { filePath?: string }
): PackageKind {
  return classifyPackage(pkgInput, options).kind;
}

export function classifyPackageKind(
  pkgInput: PackageJsonInput,
  options?: { filePath?: string }
): PackageKind {
  return classifyPackage(pkgInput, options).kind;
}

export function isApplication(pkgInput: PackageJsonInput): boolean {
  return classifyPackage(pkgInput).isApplication;
}

export function isLibrary(pkgInput: PackageJsonInput): boolean {
  return classifyPackage(pkgInput).isLibrary;
}

export function isMonorepo(pkgInput: PackageJsonInput): boolean {
  return classifyPackage(pkgInput).isMonorepo;
}

export function isEsm(pkgInput: PackageJsonInput): boolean {
  return classifyPackage(pkgInput).isEsm;
}

function parseSourceAst(source: string, filePath?: string): any {
  const fp = (filePath || "").toLowerCase();
  const plugins: ParserPlugin[] = fp.endsWith(".tsx")
    ? ["typescript", "jsx"]
    : fp.endsWith(".ts")
    ? ["typescript"]
    : ["jsx"];

  const attempts: ("module" | "script" | "unambiguous")[] = [
    "module",
    "script",
    "unambiguous",
  ];
  let lastError: unknown;

  for (const sourceType of attempts) {
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

  throw lastError;
}

export interface M3FileCheckResult {
  eligible: boolean;
  unknowns: UnknownRecord[];
  featuresFound: {
    dirname: boolean;
    filename: boolean;
    requireResolve: boolean;
    conditionalRequire: boolean;
  };
}

/**
 * Requirement 8.4:
 * WHERE M3 conversion is enabled, IF a file uses __dirname, __filename, require.resolve
 * or a conditional require, THEN THE Grimoire SHALL leave the file unchanged and record unknown.
 */
export function inspectFileForM3(
  source: string,
  filePath?: string
): M3FileCheckResult {
  const file = filePath || "file.js";
  const unknowns: UnknownRecord[] = [];
  const featuresFound = {
    dirname: false,
    filename: false,
    requireResolve: false,
    conditionalRequire: false,
  };

  let ast: any;
  try {
    ast = parseSourceAst(source, filePath);
  } catch (err: unknown) {
    const line =
      typeof err === "object" && err !== null && "loc" in err
        ? (err as any).loc?.line
        : undefined;
    unknowns.push({
      ruleId: "M3",
      reason: "parse_error",
      file,
      ...(line !== undefined ? { line } : {}),
    });
    return {
      eligible: false,
      unknowns,
      featuresFound,
    };
  }

  function isIdentifierUsage(
    node: any,
    ancestors: any[],
    targetName: string
  ): boolean {
    if (node.type !== "Identifier" || node.name !== targetName) return false;
    const parent = ancestors[ancestors.length - 1];
    if (!parent) return true;
    if (
      parent.type === "MemberExpression" &&
      parent.property === node &&
      !parent.computed
    ) {
      return false;
    }
    if (
      parent.type === "ObjectProperty" &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand
    ) {
      return false;
    }
    if (
      parent.type === "ClassMethod" &&
      parent.key === node &&
      !parent.computed
    ) {
      return false;
    }
    if (
      parent.type === "ObjectMethod" &&
      parent.key === node &&
      !parent.computed
    ) {
      return false;
    }
    if (parent.type === "VariableDeclarator" && parent.id === node) {
      return false;
    }
    if (parent.type === "FunctionDeclaration" && parent.id === node) {
      return false;
    }
    return true;
  }

  function isRequireResolve(node: any): boolean {
    if (node.type === "MemberExpression") {
      const isReq =
        node.object?.type === "Identifier" && node.object.name === "require";
      const isRes =
        (!node.computed &&
          node.property?.type === "Identifier" &&
          node.property.name === "resolve") ||
        (node.computed &&
          node.property?.type === "StringLiteral" &&
          node.property.value === "resolve");
      return Boolean(isReq && isRes);
    }
    return false;
  }

  function isInsideConditional(ancestors: any[]): boolean {
    for (const a of ancestors) {
      const type = a.type;
      if (
        type === "IfStatement" ||
        type === "ConditionalExpression" ||
        type === "LogicalExpression" ||
        type === "SwitchStatement" ||
        type === "SwitchCase" ||
        type === "TryStatement" ||
        type === "CatchClause" ||
        type === "WhileStatement" ||
        type === "DoWhileStatement" ||
        type === "ForStatement" ||
        type === "ForInStatement" ||
        type === "ForOfStatement" ||
        type === "FunctionDeclaration" ||
        type === "FunctionExpression" ||
        type === "ArrowFunctionExpression" ||
        type === "ClassMethod" ||
        type === "ObjectMethod"
      ) {
        return true;
      }
    }
    return false;
  }

  function walk(node: any, ancestors: any[] = []): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, ancestors);
      }
      return;
    }

    const line = node.loc?.start?.line;

    // 1. __dirname
    if (isIdentifierUsage(node, ancestors, "__dirname")) {
      featuresFound.dirname = true;
      unknowns.push({
        ruleId: "M3",
        reason: "__dirname",
        file,
        ...(line !== undefined ? { line } : {}),
      });
    }

    // 2. __filename
    if (isIdentifierUsage(node, ancestors, "__filename")) {
      featuresFound.filename = true;
      unknowns.push({
        ruleId: "M3",
        reason: "__filename",
        file,
        ...(line !== undefined ? { line } : {}),
      });
    }

    // 3. require.resolve
    if (isRequireResolve(node)) {
      featuresFound.requireResolve = true;
      unknowns.push({
        ruleId: "M3",
        reason: "require.resolve",
        file,
        ...(line !== undefined ? { line } : {}),
      });
    }

    // 4. conditional require
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      const isCond = isInsideConditional(ancestors);
      const isDynamic =
        node.arguments.length !== 1 ||
        node.arguments[0]?.type !== "StringLiteral";
      if (isCond || isDynamic) {
        featuresFound.conditionalRequire = true;
        unknowns.push({
          ruleId: "M3",
          reason: "conditional_require",
          file,
          ...(line !== undefined ? { line } : {}),
        });
      }
    }

    const nextAncestors = [...ancestors, node];
    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "comments" ||
        key === "leadingComments" ||
        key === "trailingComments"
      ) {
        continue;
      }
      const val = node[key];
      if (val && typeof val === "object") {
        walk(val, nextAncestors);
      }
    }
  }

  walk(ast);

  const eligible =
    !featuresFound.dirname &&
    !featuresFound.filename &&
    !featuresFound.requireResolve &&
    !featuresFound.conditionalRequire &&
    unknowns.length === 0;

  return {
    eligible,
    unknowns,
    featuresFound,
  };
}

export function canConvertFileToEsm(
  source: string,
  filePath?: string
): boolean {
  return inspectFileForM3(source, filePath).eligible;
}

export function isEligibleForM3Conversion(
  source: string,
  filePath?: string
): boolean {
  return inspectFileForM3(source, filePath).eligible;
}

export interface M3TransformResult {
  code: string;
  changed: boolean;
  editsCount: number;
}

/**
 * Requirement 8.3:
 * Convert application packages through AST transforms.
 */
export function convertCommonJsToEsm(
  source: string,
  filePath?: string
): M3TransformResult {
  let ast: any;
  try {
    ast = parseSourceAst(source, filePath);
  } catch {
    return {
      code: source,
      changed: false,
      editsCount: 0,
    };
  }

  interface Edit {
    start: number;
    end: number;
    text: string;
  }
  const edits: Edit[] = [];

  for (const stmt of ast.program.body) {
    // 1. VariableDeclaration with require(...)
    if (stmt.type === "VariableDeclaration") {
      let allRequire = true;
      const imports: string[] = [];

      for (const decl of stmt.declarations) {
        let init = decl.init;
        if (
          init &&
          init.type === "MemberExpression" &&
          !init.computed &&
          init.property?.type === "Identifier" &&
          init.property.name === "default"
        ) {
          init = init.object;
        }

        if (
          init &&
          init.type === "CallExpression" &&
          init.callee?.type === "Identifier" &&
          init.callee.name === "require" &&
          init.arguments.length === 1 &&
          init.arguments[0]?.type === "StringLiteral"
        ) {
          const modPath = init.arguments[0].value;
          if (decl.id.type === "Identifier") {
            imports.push(`import ${decl.id.name} from '${modPath}';`);
          } else if (decl.id.type === "ObjectPattern") {
            const specifiers: string[] = [];
            for (const prop of decl.id.properties) {
              if (
                prop.type === "ObjectProperty" &&
                prop.key.type === "Identifier" &&
                prop.value.type === "Identifier"
              ) {
                if (prop.key.name === prop.value.name) {
                  if (prop.key.name === "default") {
                    specifiers.push(`default as ${prop.value.name}`);
                  } else {
                    specifiers.push(prop.key.name);
                  }
                } else {
                  if (prop.key.name === "default") {
                    specifiers.push(`default as ${prop.value.name}`);
                  } else {
                    specifiers.push(`${prop.key.name} as ${prop.value.name}`);
                  }
                }
              }
            }
            if (specifiers.length > 0) {
              imports.push(
                `import { ${specifiers.join(", ")} } from '${modPath}';`
              );
            }
          }
        } else {
          allRequire = false;
        }
      }

      if (
        allRequire &&
        imports.length > 0 &&
        typeof stmt.start === "number" &&
        typeof stmt.end === "number"
      ) {
        edits.push({
          start: stmt.start,
          end: stmt.end,
          text: imports.join("\n"),
        });
      }
    }

    // 2. ExpressionStatement
    if (stmt.type === "ExpressionStatement") {
      const expr = stmt.expression;
      if (
        expr.type === "CallExpression" &&
        expr.callee?.type === "Identifier" &&
        expr.callee.name === "require" &&
        expr.arguments.length === 1 &&
        expr.arguments[0]?.type === "StringLiteral" &&
        typeof stmt.start === "number" &&
        typeof stmt.end === "number"
      ) {
        edits.push({
          start: stmt.start,
          end: stmt.end,
          text: `import '${expr.arguments[0].value}';`,
        });
      } else if (
        expr.type === "AssignmentExpression" &&
        expr.operator === "="
      ) {
        const left = expr.left;
        // module.exports = ...
        if (
          left.type === "MemberExpression" &&
          left.object?.type === "Identifier" &&
          left.object.name === "module" &&
          left.property?.type === "Identifier" &&
          left.property.name === "exports" &&
          typeof stmt.start === "number" &&
          typeof stmt.end === "number" &&
          typeof expr.right.start === "number" &&
          typeof expr.right.end === "number"
        ) {
          const rhsText = source.slice(expr.right.start, expr.right.end);
          edits.push({
            start: stmt.start,
            end: stmt.end,
            text: `export default ${rhsText};`,
          });
        }
        // module.exports.foo = ... or exports.foo = ...
        else if (
          ((left.type === "MemberExpression" &&
            left.object?.type === "MemberExpression" &&
            left.object.object?.type === "Identifier" &&
            left.object.object.name === "module" &&
            left.object.property?.type === "Identifier" &&
            left.object.property.name === "exports") ||
            (left.type === "MemberExpression" &&
              left.object?.type === "Identifier" &&
              left.object.name === "exports")) &&
          left.property?.type === "Identifier" &&
          typeof stmt.start === "number" &&
          typeof stmt.end === "number" &&
          typeof expr.right.start === "number" &&
          typeof expr.right.end === "number"
        ) {
          const propName = left.property.name;
          const rhsText = source.slice(expr.right.start, expr.right.end);
          if (
            expr.right.type === "Identifier" &&
            expr.right.name === propName
          ) {
            edits.push({
              start: stmt.start,
              end: stmt.end,
              text: `export { ${propName} };`,
            });
          } else {
            edits.push({
              start: stmt.start,
              end: stmt.end,
              text: `export const ${propName} = ${rhsText};`,
            });
          }
        }
      }
    }
  }

  if (edits.length === 0) {
    return {
      code: source,
      changed: false,
      editsCount: 0,
    };
  }

  edits.sort((a, b) => b.start - a.start);
  let transformed = source;
  for (const edit of edits) {
    transformed =
      transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end);
  }

  try {
    parseSourceAst(transformed, filePath);
    return {
      code: transformed,
      changed: true,
      editsCount: edits.length,
    };
  } catch {
    return {
      code: source,
      changed: false,
      editsCount: 0,
    };
  }
}

export function transformCommonJsToEsm(
  source: string,
  filePath?: string
): string {
  return convertCommonJsToEsm(source, filePath).code;
}

export interface M3InputFile {
  path: string;
  content: string;
}

export interface M3GuidanceOptions {
  m3Enabled?: boolean;
  enableM3?: boolean;
  m3?: boolean;
  packageJsonPath?: string;
}

export interface M3FileResult {
  path: string;
  originalContent: string;
  content: string;
  changed: boolean;
  skipped: boolean;
  unknowns: UnknownRecord[];
}

export interface M3GuidanceResult {
  packageClassification: PackageClassification;
  m3Enabled: boolean;
  converted: boolean;
  files: M3FileResult[];
  unknowns: UnknownRecord[];
}

export function applyM3Guidance(
  pkgInput: PackageJsonInput,
  files: M3InputFile[] = [],
  options?: M3GuidanceOptions
): M3GuidanceResult {
  const m3Switch = Boolean(
    options?.m3Enabled ?? options?.enableM3 ?? options?.m3
  );
  const pkgPath = options?.packageJsonPath || "package.json";
  const classification = classifyPackage(pkgInput, { filePath: pkgPath });

  const allUnknowns: UnknownRecord[] = [...classification.unknowns];
  const fileResults: M3FileResult[] = [];

  // Library, monorepo, or unknown: stay in CommonJS and record unknown with reference U4
  if (
    classification.kind === "library" ||
    classification.kind === "unknown" ||
    classification.kind === "monorepo"
  ) {
    return {
      packageClassification: classification,
      m3Enabled: m3Switch,
      converted: false,
      files: files.map((f) => ({
        path: f.path,
        originalContent: f.content,
        content: f.content,
        changed: false,
        skipped: true,
        unknowns: [],
      })),
      unknowns: allUnknowns,
    };
  }

  // Already ESM
  if (classification.kind === "esm") {
    return {
      packageClassification: classification,
      m3Enabled: m3Switch,
      converted: false,
      files: files.map((f) => ({
        path: f.path,
        originalContent: f.content,
        content: f.content,
        changed: false,
        skipped: false,
        unknowns: [],
      })),
      unknowns: allUnknowns,
    };
  }

  // Application package: convert ONLY when M3 switch is on
  if (!m3Switch) {
    return {
      packageClassification: classification,
      m3Enabled: false,
      converted: false,
      files: files.map((f) => ({
        path: f.path,
        originalContent: f.content,
        content: f.content,
        changed: false,
        skipped: true,
        unknowns: [],
      })),
      unknowns: allUnknowns,
    };
  }

  // M3 switch is ON and package is application:
  for (const file of files) {
    const inspection = inspectFileForM3(file.content, file.path);
    if (!inspection.eligible) {
      allUnknowns.push(...inspection.unknowns);
      fileResults.push({
        path: file.path,
        originalContent: file.content,
        content: file.content,
        changed: false,
        skipped: true,
        unknowns: inspection.unknowns,
      });
    } else {
      const transform = convertCommonJsToEsm(file.content, file.path);
      fileResults.push({
        path: file.path,
        originalContent: file.content,
        content: transform.code,
        changed: transform.changed,
        skipped: false,
        unknowns: [],
      });
    }
  }

  const anyConverted = fileResults.some((f) => f.changed);

  return {
    packageClassification: classification,
    m3Enabled: true,
    converted: anyConverted,
    files: fileResults,
    unknowns: allUnknowns,
  };
}

export function getM3Guidance(
  pkgInput: PackageJsonInput,
  files: M3InputFile[] = [],
  options?: M3GuidanceOptions
): M3GuidanceResult {
  return applyM3Guidance(pkgInput, files, options);
}

/**
 * Requirement 8.5:
 * WHERE M4 conversion is enabled, THE Grimoire SHALL target the current stable Vite version
 * looked up at run time and record the CommonsChunkPlugin mapping as unknown.
 */
export function lookupCurrentStableViteVersion(options?: {
  overrideVersion?: string;
  timeoutMs?: number;
}): string {
  if (
    options?.overrideVersion &&
    typeof options.overrideVersion === "string" &&
    options.overrideVersion.trim()
  ) {
    return options.overrideVersion.trim();
  }
  try {
    const raw = execSync("npm view vite version", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs ?? 10000,
    });
    const ver = raw.trim();
    if (ver) {
      return ver;
    }
  } catch {
    // fallback if npm command fails
  }
  return "8.3.6";
}

export function lookupStableViteVersion(override?: string): string {
  return lookupCurrentStableViteVersion({ overrideVersion: override });
}

export function getStableViteVersion(override?: string): string {
  return lookupCurrentStableViteVersion({ overrideVersion: override });
}

export async function lookupCurrentStableViteVersionAsync(options?: {
  overrideVersion?: string;
  timeoutMs?: number;
}): Promise<string> {
  return lookupCurrentStableViteVersion(options);
}

export function findCommonsChunkPlugin(
  code: string,
  filePath?: string
): UnknownRecord | null {
  const file = filePath || "webpack.config.js";
  let ast: any;
  try {
    ast = parseSourceAst(code, filePath);
  } catch {
    const match = /CommonsChunkPlugin/.exec(code);
    if (match) {
      const lines = code.slice(0, match.index).split("\n");
      return {
        ruleId: "M4",
        reason: "CommonsChunkPlugin",
        file,
        line: lines.length,
      };
    }
    return null;
  }

  let found: UnknownRecord | null = null;
  function walk(node: any): void {
    if (!node || typeof node !== "object" || found) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.type === "Identifier" && node.name === "CommonsChunkPlugin") {
      const line = node.loc?.start?.line;
      found = {
        ruleId: "M4",
        reason: "CommonsChunkPlugin",
        file,
        ...(line !== undefined ? { line } : {}),
      };
      return;
    }
    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "comments" ||
        key === "leadingComments" ||
        key === "trailingComments"
      ) {
        continue;
      }
      const val = node[key];
      if (val && typeof val === "object") walk(val);
    }
  }
  walk(ast);
  return found;
}

export interface M4GuidanceOptions {
  m4Enabled?: boolean;
  enableM4?: boolean;
  m4?: boolean;
  configFile?: string;
  configContent?: string;
  viteVersion?: string;
  unknowns?: UnknownRecord[];
}

export interface M4GuidanceResult {
  ruleId: "M4";
  m4Enabled: boolean;
  targetViteVersion: string;
  vitePackage: string;
  recommendedDependencies: Record<string, string>;
  unknowns: UnknownRecord[];
  notes: string[];
}

export function getM4Guidance(options?: M4GuidanceOptions): M4GuidanceResult {
  const m4Enabled = Boolean(
    options?.m4Enabled ?? options?.enableM4 ?? options?.m4 ?? true
  );
  const targetViteVersion = lookupCurrentStableViteVersion({
    overrideVersion: options?.viteVersion,
  });

  const unknowns: UnknownRecord[] = [];
  let record: UnknownRecord | null = null;

  if (options?.configContent) {
    record = findCommonsChunkPlugin(options.configContent, options?.configFile);
  }
  if (!record) {
    record = {
      ruleId: "M4",
      reason: "CommonsChunkPlugin",
      ...(options?.configFile ? { file: options.configFile } : {}),
    };
  }

  unknowns.push(record);
  if (options?.unknowns) {
    options.unknowns.push(record);
  }

  return {
    ruleId: "M4",
    m4Enabled,
    targetViteVersion,
    vitePackage: "vite",
    recommendedDependencies: {
      vite: `^${targetViteVersion}`,
    },
    unknowns,
    notes: [
      `Target current stable Vite version: ${targetViteVersion}`,
      "CommonsChunkPlugin mapping is recorded as unknown",
    ],
  };
}
