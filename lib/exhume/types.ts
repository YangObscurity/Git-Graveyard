/**
 * Types for Exhumer manifest inspection and script detection.
 * Requirements: 11.4 to 11.10.
 * Task: 8.2.
 */

export type SupportedLanguage = "node" | "python";

export type PackageManager = "npm" | "pip" | "poetry" | "unknown";

/**
 * Requirement 11.10 / Design M13: "No tests found" rule ID.
 */
export const NO_TESTS_FOUND_RULE_ID = "M13" as const;
export type NoTestsFoundRuleId = typeof NO_TESTS_FOUND_RULE_ID;

/**
 * Requirement 11.10 / Design M13: "No tests found" finding label.
 */
export const NO_TESTS_FOUND_LABEL = "No tests found" as const;
export type NoTestsFoundLabel = typeof NO_TESTS_FOUND_LABEL;

/**
 * Input file descriptor.
 */
export interface FileEntry {
  path: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Flexible file list input.
 */
export type FileListInput =
  | readonly string[]
  | readonly FileEntry[]
  | Record<string, string>
  | Map<string, string>;

/**
 * Node package.json scripts map.
 */
export interface PackageJsonScripts {
  build?: string;
  test?: string;
  [key: string]: string | undefined;
}

/**
 * Node package.json structure subset.
 */
export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: PackageJsonScripts;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Finding record recorded when no tests are found.
 * Requirement 11.10: Record "No tests found" with the rule that decided it (M13).
 */
export interface NoTestsFoundRecord {
  readonly ruleId: NoTestsFoundRuleId;
  readonly title: NoTestsFoundLabel;
  readonly status: NoTestsFoundLabel;
  readonly reason: string;
  readonly language?: SupportedLanguage;
}

/**
 * Inspection result for build scripts.
 * Requirement 11.9: If the repository has no build script, mark build not run with reason.
 */
export interface BuildInspectionResult {
  readonly hasBuildScript: boolean;
  readonly script?: string;
  readonly command?: readonly string[];
  readonly commandLine?: string;
  readonly status?: "not run";
  readonly reason?: string;
}

/**
 * Inspection result for test scripts and test files.
 * Requirement 11.10: Identify missing tests, default placeholders, or missing test files.
 */
export interface TestInspectionResult {
  readonly hasTests: boolean;
  readonly testCommand?: readonly string[];
  readonly testCommandLine?: string;
  readonly noTestsFound: boolean;
  readonly ruleId?: NoTestsFoundRuleId;
  readonly reason?: string;
  readonly record?: NoTestsFoundRecord;
  readonly isPlaceholder?: boolean;
  readonly testFiles?: readonly string[];
}

/**
 * Node-specific manifest inspection result.
 */
export interface NodeInspectionResult {
  readonly hasManifest: boolean;
  readonly manifestPath?: string;
  readonly packageManager: "npm";
  readonly lockFile?: string;
  readonly build: BuildInspectionResult;
  readonly test: TestInspectionResult;
  readonly installCommand: readonly string[];
  readonly installRetryCommand?: readonly string[];
  readonly versionCommands: readonly (readonly string[])[];
}

/**
 * Python-specific manifest inspection result.
 */
export interface PythonInspectionResult {
  readonly hasManifest: boolean;
  readonly manifests: readonly string[];
  readonly packageManager: "poetry" | "pip";
  readonly lockFile?: string;
  readonly build: BuildInspectionResult;
  readonly test: TestInspectionResult;
  readonly installCommand: readonly string[];
  readonly installRetryCommand?: readonly string[];
  readonly versionCommands: readonly (readonly string[])[];
}

/**
 * Result of evaluating pytest --collect-only exit code.
 * Requirement 11.10: Python pytest collect returns exit code 5 -> "No tests found" (M13).
 */
export interface PytestCollectEvaluation {
  readonly noTestsFound: boolean;
  readonly ruleId?: NoTestsFoundRuleId;
  readonly label?: NoTestsFoundLabel;
  readonly reason?: string;
  readonly record?: NoTestsFoundRecord;
  readonly exitCode: number;
}

/**
 * Input options for inspecting repository manifests.
 */
export interface ManifestInspectionInput {
  files?: FileListInput;
  packageJson?: PackageJson | string | Record<string, unknown> | null;
  pyprojectToml?: string | Record<string, unknown> | null;
  setupPy?: string | null;
  setupCfg?: string | null;
  pipfile?: string | null;
  requirementsTxt?: string | string[] | null;
}

/**
 * Overall manifest inspection result across all detected languages.
 */
export interface ManifestInspectionResult {
  readonly languages: readonly SupportedLanguage[];
  readonly primaryLanguage: SupportedLanguage | "unknown";
  readonly manifestFiles: readonly string[];
  readonly lockFiles: readonly string[];
  readonly packageManager: PackageManager;
  readonly versionCommands: readonly (readonly string[])[];
  readonly installCommand: readonly string[];
  readonly installRetryCommand?: readonly string[];
  readonly build: BuildInspectionResult;
  readonly test: TestInspectionResult;
  readonly node?: NodeInspectionResult;
  readonly python?: PythonInspectionResult;
}
