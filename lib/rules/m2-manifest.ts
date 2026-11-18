import { createRequire } from "node:module";
import type { UnknownRecord } from "../grimoire/types";

// Requirement 7.9: engines.node target and step note
export const REQUIRED_NODE_ENGINE = ">=22";
export const NODE_22_NOTE = "requires Node 22 or later";

// Requirement 7.10: unparseable engines.node unknown reason
export const ENGINES_UNPARSEABLE_REASON = "engines_unparseable";

// Requirement 7.8: default reason for remaining request imports
export const REQUEST_STILL_IMPORTED_REASON = "request_still_imported";

// Try to load semver dynamically if available
const req = createRequire(import.meta.url);
let semverLib: any = null;
try {
  semverLib = req("semver");
} catch {
  semverLib = null;
}

export interface M2ManifestOptions {
  /**
   * Whether any file in the manifest directory still imports request.
   * When false (default), request is removed from dependencies (Requirement 7.7).
   * When true, request is kept and unknown is recorded (Requirement 7.8).
   */
  stillImportsRequest?: boolean;

  /**
   * Alias for stillImportsRequest.
   */
  hasRemainingRequestImports?: boolean;

  /**
   * Alias for stillImportsRequest.
   */
  filesStillImportRequest?: boolean;

  /**
   * Complement of stillImportsRequest. If allFilesMigrated is true, stillImportsRequest is false.
   */
  allFilesMigrated?: boolean;

  /**
   * Remaining imports count or array of file paths.
   * If non-empty array or number > 0, treated as stillImportsRequest: true.
   */
  remainingImports?: number | string[] | readonly string[];

  /**
   * Whether M2 rule fired for this manifest directory.
   * Defaults to true (Requirement 7.9).
   */
  m2Fired?: boolean;

  /**
   * Path of the manifest file, e.g. "package.json".
   * Defaults to "package.json".
   */
  filePath?: string;

  /**
   * Alias for filePath.
   */
  manifestPath?: string;

  /**
   * Custom reason for Requirement 7.8 unknown record if desired.
   * Defaults to "request_still_imported".
   */
  reason?: string;

  /**
   * Alias for reason for Requirement 7.8.
   */
  requestStillImportedReason?: string;
}

export interface M2DependencyOptions {
  stillImportsRequest?: boolean;
  hasRemainingRequestImports?: boolean;
  filesStillImportRequest?: boolean;
  allFilesMigrated?: boolean;
  remainingImports?: number | string[] | readonly string[];
  filePath?: string;
  manifestPath?: string;
  reason?: string;
  requestStillImportedReason?: string;
}

export interface M2EnginesOptions {
  m2Fired?: boolean;
  filePath?: string;
  manifestPath?: string;
}

export interface M2ManifestResult {
  manifest: Record<string, unknown>;
  packageJson: Record<string, unknown>;
  pkg: Record<string, unknown>;
  unknownRecords: UnknownRecord[];
  unknowns: UnknownRecord[];
  notes: string[];
  note?: string;
  changed: boolean;
  dependenciesChanged: boolean;
  enginesChanged: boolean;
  [Symbol.iterator](): Iterator<Record<string, unknown> | UnknownRecord[]>;
}

export interface M2DependencyResult {
  manifest: Record<string, unknown>;
  packageJson: Record<string, unknown>;
  pkg: Record<string, unknown>;
  unknownRecords: UnknownRecord[];
  unknowns: UnknownRecord[];
  changed: boolean;
  removed: boolean;
  [Symbol.iterator](): Iterator<Record<string, unknown> | UnknownRecord[]>;
}

export interface M2EnginesResult {
  manifest: Record<string, unknown>;
  packageJson: Record<string, unknown>;
  pkg: Record<string, unknown>;
  unknownRecords: UnknownRecord[];
  unknowns: UnknownRecord[];
  notes: string[];
  note?: string;
  changed: boolean;
  [Symbol.iterator](): Iterator<Record<string, unknown> | UnknownRecord[]>;
}

export interface NodeRangeEvaluation {
  absent: boolean;
  unparseable: boolean;
  below22: boolean;
  minVersion: string | null;
  raw: unknown;
}

function clonePackageJson(pkg: Record<string, unknown>): Record<string, unknown> {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    return {};
  }
  return JSON.parse(JSON.stringify(pkg));
}

interface SemverTriple {
  major: number;
  minor: number;
  patch: number;
}

function compareTriples(a: SemverTriple, b: SemverTriple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function parseSimpleVersion(s: string): SemverTriple | null {
  const m = s.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: m[2] !== undefined ? parseInt(m[2], 10) : 0,
    patch: m[3] !== undefined ? parseInt(m[3], 10) : 0,
  };
}

function fallbackEvaluateNodeRange(
  cleanedStr: string,
  rawRange: unknown
): NodeRangeEvaluation {
  if (cleanedStr === "" || cleanedStr === "*") {
    return {
      absent: false,
      unparseable: false,
      below22: true,
      minVersion: "0.0.0",
      raw: rawRange,
    };
  }

  // Reject unsupported / invalid characters
  if (/[^\d\s><=^~.vVxX*|-]/.test(cleanedStr)) {
    return {
      absent: false,
      unparseable: true,
      below22: false,
      minVersion: null,
      raw: rawRange,
    };
  }

  const normalized = cleanedStr.replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1");
  const orParts = normalized.split("||");
  let overallMin: SemverTriple | null = null;

  for (const part of orParts) {
    const trimmed = part.trim();
    if (!trimmed) {
      return {
        absent: false,
        unparseable: true,
        below22: false,
        minVersion: null,
        raw: rawRange,
      };
    }

    // Hyphen range: 14 - 16 or 14.0.0 - 16.0.0
    const hyphenMatch = trimmed.match(
      /^([v=\s]*\d+(?:\.\d+)*(?:-[a-zA-Z0-9.-]+)?)\s+-\s+([v=\s]*\d+(?:\.\d+)*(?:-[a-zA-Z0-9.-]+)?)$/
    );
    if (hyphenMatch) {
      const v = parseSimpleVersion(hyphenMatch[1]);
      if (!v) {
        return {
          absent: false,
          unparseable: true,
          below22: false,
          minVersion: null,
          raw: rawRange,
        };
      }
      if (!overallMin || compareTriples(v, overallMin) < 0) {
        overallMin = v;
      }
      continue;
    }

    const tokens = trimmed.split(/\s+/);
    let setMin: SemverTriple = { major: 0, minor: 0, patch: 0 };

    for (const token of tokens) {
      const m = token.match(
        /^(>=|<=|>|<|=|~|\^)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([a-zA-Z0-9.-]+))?$/i
      );
      if (!m) {
        return {
          absent: false,
          unparseable: true,
          below22: false,
          minVersion: null,
          raw: rawRange,
        };
      }
      const op = m[1] || "=";
      const majStr = m[2];
      const minStr = m[3];
      const patStr = m[4];

      if (majStr === "*" || majStr.toLowerCase() === "x") {
        continue;
      }

      const maj = parseInt(majStr, 10);
      const min =
        minStr !== undefined && minStr !== "*" && minStr.toLowerCase() !== "x"
          ? parseInt(minStr, 10)
          : 0;
      const pat =
        patStr !== undefined && patStr !== "*" && patStr.toLowerCase() !== "x"
          ? parseInt(patStr, 10)
          : 0;
      const ver: SemverTriple = { major: maj, minor: min, patch: pat };

      if (op === ">=" || op === "=" || op === "^" || op === "~") {
        if (compareTriples(ver, setMin) > 0) {
          setMin = ver;
        }
      } else if (op === ">") {
        const nextVer: SemverTriple = { major: maj, minor: min, patch: pat + 1 };
        if (minStr === undefined) {
          nextVer.major = maj + 1;
          nextVer.minor = 0;
          nextVer.patch = 0;
        } else if (patStr === undefined) {
          nextVer.minor = min + 1;
          nextVer.patch = 0;
        }
        if (compareTriples(nextVer, setMin) > 0) {
          setMin = nextVer;
        }
      }
    }

    if (!overallMin || compareTriples(setMin, overallMin) < 0) {
      overallMin = setMin;
    }
  }

  if (!overallMin) {
    return {
      absent: false,
      unparseable: true,
      below22: false,
      minVersion: null,
      raw: rawRange,
    };
  }

  const minVersionStr = `${overallMin.major}.${overallMin.minor}.${overallMin.patch}`;
  return {
    absent: false,
    unparseable: false,
    below22: overallMin.major < 22,
    minVersion: minVersionStr,
    raw: rawRange,
  };
}

/**
 * Pure function evaluating a node engine range string or value.
 * Determines whether it is absent, unparseable, or has minimum version below 22.
 */
export function evaluateNodeEngine(rawRange: unknown): NodeRangeEvaluation {
  if (rawRange === undefined || rawRange === null) {
    return {
      absent: true,
      unparseable: false,
      below22: true,
      minVersion: null,
      raw: rawRange,
    };
  }

  if (typeof rawRange !== "string") {
    return {
      absent: false,
      unparseable: true,
      below22: false,
      minVersion: null,
      raw: rawRange,
    };
  }

  const str = rawRange.trim();
  if (str === "") {
    return {
      absent: false,
      unparseable: false,
      below22: true,
      minVersion: "0.0.0",
      raw: rawRange,
    };
  }

  if (semverLib) {
    try {
      const valid = semverLib.validRange(str);
      if (!valid) {
        return {
          absent: false,
          unparseable: true,
          below22: false,
          minVersion: null,
          raw: rawRange,
        };
      }
      const min = semverLib.minVersion(str);
      if (!min) {
        return {
          absent: false,
          unparseable: true,
          below22: false,
          minVersion: null,
          raw: rawRange,
        };
      }
      return {
        absent: false,
        unparseable: false,
        below22: min.major < 22,
        minVersion: min.version,
        raw: rawRange,
      };
    } catch {
      return {
        absent: false,
        unparseable: true,
        below22: false,
        minVersion: null,
        raw: rawRange,
      };
    }
  }

  return fallbackEvaluateNodeRange(str, rawRange);
}

/**
 * Requirement 7.7 & 7.8:
 * Remove request from dependencies when no file in the manifest directory still imports request (7.7).
 * Otherwise keep it and record unknown (7.8).
 * Pure function over parsed package.json objects.
 */
export function removeRequestDependency(
  manifest: Record<string, unknown>,
  options?: M2DependencyOptions | boolean
): M2DependencyResult {
  const filePath =
    (typeof options === "object" && options !== null
      ? options.filePath || options.manifestPath
      : undefined) || "package.json";

  let stillImports = false;
  let reason = REQUEST_STILL_IMPORTED_REASON;

  if (typeof options === "boolean") {
    stillImports = options;
  } else if (options && typeof options === "object") {
    if (typeof options.stillImportsRequest === "boolean") {
      stillImports = options.stillImportsRequest;
    } else if (typeof options.hasRemainingRequestImports === "boolean") {
      stillImports = options.hasRemainingRequestImports;
    } else if (typeof options.filesStillImportRequest === "boolean") {
      stillImports = options.filesStillImportRequest;
    } else if (typeof options.allFilesMigrated === "boolean") {
      stillImports = !options.allFilesMigrated;
    } else if (Array.isArray(options.remainingImports)) {
      stillImports = options.remainingImports.length > 0;
    } else if (typeof options.remainingImports === "number") {
      stillImports = options.remainingImports > 0;
    }

    if (options.reason) {
      reason = options.reason;
    } else if (options.requestStillImportedReason) {
      reason = options.requestStillImportedReason;
    }
  }

  const newPkg = clonePackageJson(manifest);
  const unknownRecords: UnknownRecord[] = [];
  let changed = false;
  let removed = false;

  if (!stillImports) {
    // Requirement 7.7
    if (
      newPkg.dependencies &&
      typeof newPkg.dependencies === "object" &&
      !Array.isArray(newPkg.dependencies)
    ) {
      const deps = { ...(newPkg.dependencies as Record<string, unknown>) };
      if ("request" in deps) {
        delete deps.request;
        newPkg.dependencies = deps;
        changed = true;
        removed = true;
      }
    }
  } else {
    // Requirement 7.8
    unknownRecords.push({
      ruleId: "M2",
      reason,
      file: filePath,
    });
  }

  return {
    manifest: newPkg,
    packageJson: newPkg,
    pkg: newPkg,
    unknownRecords,
    unknowns: unknownRecords,
    changed,
    removed,
    *[Symbol.iterator]() {
      yield newPkg;
      yield unknownRecords;
    },
  };
}

/**
 * Requirement 7.9 & 7.10:
 * When M2 fires and engines.node is absent or has a minimum below Node 22,
 * set engines.node to >=22 and add the note requires Node 22 or later (7.9).
 * When engines.node cannot be parsed, leave it unchanged and record unknown
 * with reason engines_unparseable (7.10).
 * Pure function over parsed package.json objects.
 */
export function updateNodeEngines(
  manifest: Record<string, unknown>,
  options?: M2EnginesOptions | boolean
): M2EnginesResult {
  const filePath =
    (typeof options === "object" && options !== null
      ? options.filePath || options.manifestPath
      : undefined) || "package.json";

  let m2Fired = true;
  if (typeof options === "boolean") {
    m2Fired = options;
  } else if (options && typeof options === "object" && typeof options.m2Fired === "boolean") {
    m2Fired = options.m2Fired;
  }

  const newPkg = clonePackageJson(manifest);
  const unknownRecords: UnknownRecord[] = [];
  const notes: string[] = [];
  let changed = false;

  if (!m2Fired) {
    return {
      manifest: newPkg,
      packageJson: newPkg,
      pkg: newPkg,
      unknownRecords,
      unknowns: unknownRecords,
      notes,
      changed,
      *[Symbol.iterator]() {
        yield newPkg;
        yield unknownRecords;
      },
    };
  }

  const enginesObj =
    newPkg.engines && typeof newPkg.engines === "object" && !Array.isArray(newPkg.engines)
      ? (newPkg.engines as Record<string, unknown>)
      : null;

  const rawNodeRange = enginesObj ? enginesObj.node : undefined;
  const evaluation = evaluateNodeEngine(rawNodeRange);

  if (evaluation.unparseable) {
    // Requirement 7.10
    unknownRecords.push({
      ruleId: "M2",
      reason: ENGINES_UNPARSEABLE_REASON,
      file: filePath,
    });
  } else if (evaluation.absent || evaluation.below22) {
    // Requirement 7.9
    const updatedEngines: Record<string, unknown> = {
      ...(enginesObj ? enginesObj : {}),
      node: REQUIRED_NODE_ENGINE,
    };
    newPkg.engines = updatedEngines;
    notes.push(NODE_22_NOTE);
    changed = true;
  }

  return {
    manifest: newPkg,
    packageJson: newPkg,
    pkg: newPkg,
    unknownRecords,
    unknowns: unknownRecords,
    notes,
    note: notes[0],
    changed,
    *[Symbol.iterator]() {
      yield newPkg;
      yield unknownRecords;
    },
  };
}

/**
 * Requirement 7.7, 7.8, 7.9, 7.10:
 * Update package.json manifest for Grimoire M2 migration.
 * - Removes request from dependencies when no file in the manifest directory still imports request (7.7).
 * - Otherwise keeps request and records unknown (7.8).
 * - When M2 fires and engines.node is absent or has a minimum below Node 22,
 *   sets engines.node to ">=22" and adds note "requires Node 22 or later" (7.9).
 * - When engines.node cannot be parsed, leaves it unchanged and records unknown
 *   with reason "engines_unparseable" (7.10).
 *
 * Pure function over parsed package.json objects.
 * Never writes to disk. Returns new parsed object and unknown records.
 */
export function updateM2Manifest(
  manifest: Record<string, unknown>,
  options?: M2ManifestOptions | boolean,
  m2FiredArg?: boolean
): M2ManifestResult {
  const filePath =
    (typeof options === "object" && options !== null
      ? options.filePath || options.manifestPath
      : undefined) || "package.json";

  let stillImports = false;
  let m2Fired = true;
  let reason = REQUEST_STILL_IMPORTED_REASON;

  if (typeof options === "boolean") {
    stillImports = options;
    if (typeof m2FiredArg === "boolean") {
      m2Fired = m2FiredArg;
    }
  } else if (options && typeof options === "object") {
    if (typeof options.stillImportsRequest === "boolean") {
      stillImports = options.stillImportsRequest;
    } else if (typeof options.hasRemainingRequestImports === "boolean") {
      stillImports = options.hasRemainingRequestImports;
    } else if (typeof options.filesStillImportRequest === "boolean") {
      stillImports = options.filesStillImportRequest;
    } else if (typeof options.allFilesMigrated === "boolean") {
      stillImports = !options.allFilesMigrated;
    } else if (Array.isArray(options.remainingImports)) {
      stillImports = options.remainingImports.length > 0;
    } else if (typeof options.remainingImports === "number") {
      stillImports = options.remainingImports > 0;
    }

    if (typeof options.m2Fired === "boolean") {
      m2Fired = options.m2Fired;
    } else if (typeof m2FiredArg === "boolean") {
      m2Fired = m2FiredArg;
    }

    if (options.reason) {
      reason = options.reason;
    } else if (options.requestStillImportedReason) {
      reason = options.requestStillImportedReason;
    }
  }

  const newPkg = clonePackageJson(manifest);
  const unknownRecords: UnknownRecord[] = [];
  const notes: string[] = [];
  let dependenciesChanged = false;
  let enginesChanged = false;

  // 1. Requirement 7.7 and 7.8: request dependency handling
  if (!stillImports) {
    if (
      newPkg.dependencies &&
      typeof newPkg.dependencies === "object" &&
      !Array.isArray(newPkg.dependencies)
    ) {
      const deps = { ...(newPkg.dependencies as Record<string, unknown>) };
      if ("request" in deps) {
        delete deps.request;
        newPkg.dependencies = deps;
        dependenciesChanged = true;
      }
    }
  } else {
    unknownRecords.push({
      ruleId: "M2",
      reason,
      file: filePath,
    });
  }

  // 2. Requirement 7.9 and 7.10: engines.node handling
  if (m2Fired) {
    const enginesObj =
      newPkg.engines && typeof newPkg.engines === "object" && !Array.isArray(newPkg.engines)
        ? (newPkg.engines as Record<string, unknown>)
        : null;

    const rawNodeRange = enginesObj ? enginesObj.node : undefined;
    const evaluation = evaluateNodeEngine(rawNodeRange);

    if (evaluation.unparseable) {
      unknownRecords.push({
        ruleId: "M2",
        reason: ENGINES_UNPARSEABLE_REASON,
        file: filePath,
      });
    } else if (evaluation.absent || evaluation.below22) {
      const updatedEngines: Record<string, unknown> = {
        ...(enginesObj ? enginesObj : {}),
        node: REQUIRED_NODE_ENGINE,
      };
      newPkg.engines = updatedEngines;
      notes.push(NODE_22_NOTE);
      enginesChanged = true;
    }
  }

  const changed = dependenciesChanged || enginesChanged;

  return {
    manifest: newPkg,
    packageJson: newPkg,
    pkg: newPkg,
    unknownRecords,
    unknowns: unknownRecords,
    notes,
    note: notes[0],
    changed,
    dependenciesChanged,
    enginesChanged,
    *[Symbol.iterator]() {
      yield newPkg;
      yield unknownRecords;
    },
  };
}

// Aliases
export const transformM2Manifest = updateM2Manifest;
export const updateManifestM2 = updateM2Manifest;
export const m2ManifestUpdate = updateM2Manifest;
export const updateEnginesNode = updateNodeEngines;

export default updateM2Manifest;
