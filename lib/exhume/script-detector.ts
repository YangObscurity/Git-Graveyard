/**
 * Script detection and manifest inspection for the Exhume harness.
 * Requirements: 11.5, 11.6, 11.7, 11.8, 11.9, 11.10.
 * Task: 8.2.
 *
 * Implements pure functions over file lists and parsed manifests.
 * No command execution is performed.
 */

import {
  NO_TESTS_FOUND_LABEL,
  NO_TESTS_FOUND_RULE_ID,
  type BuildInspectionResult,
  type FileEntry,
  type FileListInput,
  type ManifestInspectionInput,
  type ManifestInspectionResult,
  type NodeInspectionResult,
  type NoTestsFoundRecord,
  type PackageJson,
  type PytestCollectEvaluation,
  type PythonInspectionResult,
  type SupportedLanguage,
  type TestInspectionResult,
} from "./types";

/**
 * Standard npm default placeholder test scripts.
 * npm init sets: 'echo "Error: no test specified" && exit 1'
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /no test(?:s)? (?:specified|found)/i,
  /^echo\s+["']?error:?\s*no test(?:s)? (?:specified|found)["']?\s*(?:&&|;)?\s*exit\s+\d+$/i,
  /^echo\s+["']?no test(?:s)?(?: specified)?["']?$/i,
  /^(?:exit\s+[01]|:|true)$/,
];

/**
 * Normalizes relative file paths to forward-slash format without leading ./ or /.
 */
export function normalizeFilePath(filePath: string): string {
  if (typeof filePath !== "string") {
    return "";
  }
  let norm = filePath.replace(/\\/g, "/").trim();
  norm = norm.replace(/^\.?\/+/, "");
  norm = norm.replace(/\/+/g, "/");
  norm = norm.replace(/\/+$/, "");
  return norm;
}

/**
 * Extracts a list of normalized file paths from various input formats.
 */
export function extractFilePaths(input: FileListInput): string[] {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    const result: string[] = [];
    for (const item of input) {
      if (typeof item === "string") {
        const p = normalizeFilePath(item);
        if (p) result.push(p);
      } else if (item && typeof item === "object" && typeof item.path === "string") {
        const p = normalizeFilePath(item.path);
        if (p) result.push(p);
      }
    }
    return result;
  }

  if (input instanceof Map) {
    const result: string[] = [];
    for (const key of input.keys()) {
      if (typeof key === "string") {
        const p = normalizeFilePath(key);
        if (p) result.push(p);
      }
    }
    return result;
  }

  if (typeof input === "object") {
    const result: string[] = [];
    for (const key of Object.keys(input)) {
      const p = normalizeFilePath(key);
      if (p) result.push(p);
    }
    return result;
  }

  return [];
}

/**
 * Extracts the file content string for a given path from FileListInput, if available.
 */
export function extractFileContent(
  input: FileListInput,
  targetPath: string
): string | undefined {
  if (!input) return undefined;
  const targetNorm = normalizeFilePath(targetPath);

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "object" && item !== null && typeof item.path === "string") {
        if (normalizeFilePath(item.path) === targetNorm) {
          return typeof item.content === "string" ? item.content : undefined;
        }
      }
    }
    return undefined;
  }

  if (input instanceof Map) {
    for (const [key, val] of input.entries()) {
      if (normalizeFilePath(key) === targetNorm) {
        return typeof val === "string" ? val : undefined;
      }
    }
    return undefined;
  }

  if (typeof input === "object") {
    for (const [key, val] of Object.entries(input)) {
      if (normalizeFilePath(key) === targetNorm) {
        return typeof val === "string" ? val : undefined;
      }
    }
  }

  return undefined;
}

/**
 * Safely parses package.json string or returns the object.
 * Returns null if parsing fails or input is nullish.
 */
export function parsePackageJson(
  contentOrObj: unknown
): PackageJson | null {
  if (!contentOrObj) {
    return null;
  }
  if (typeof contentOrObj === "object") {
    return contentOrObj as PackageJson;
  }
  if (typeof contentOrObj === "string") {
    try {
      const parsed = JSON.parse(contentOrObj);
      if (parsed && typeof parsed === "object") {
        return parsed as PackageJson;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Checks if a test command string is a default placeholder.
 * Requirement 11.10: Identify default placeholder test commands (such as "no test specified").
 */
export function isDefaultPlaceholderTest(
  command: string | null | undefined
): boolean {
  if (typeof command !== "string") {
    return false;
  }
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return true;
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Identifies whether a given path is a Python test file.
 */
export function isPythonTestFile(filePath: string): boolean {
  const norm = normalizeFilePath(filePath).toLowerCase();
  const segments = norm.split("/");
  const basename = segments[segments.length - 1] ?? "";

  if (!basename.endsWith(".py")) {
    return false;
  }

  if (basename.startsWith("test_") || basename.endsWith("_test.py")) {
    return true;
  }

  if (basename === "test.py" || basename === "tests.py" || basename === "conftest.py") {
    return true;
  }

  const dirSegments = segments.slice(0, -1);
  if (dirSegments.some((seg) => seg === "test" || seg === "tests" || seg === "testing")) {
    return true;
  }

  return false;
}

/**
 * Finds all Python test files in a file path list.
 */
export function findPythonTestFiles(fileList: readonly string[]): string[] {
  const result: string[] = [];
  for (const file of fileList) {
    if (isPythonTestFile(file)) {
      result.push(normalizeFilePath(file));
    }
  }
  return result;
}

/**
 * Finds test files for Node projects.
 */
export function findNodeTestFiles(fileList: readonly string[]): string[] {
  const result: string[] = [];
  for (const file of fileList) {
    const norm = normalizeFilePath(file).toLowerCase();
    const segments = norm.split("/");
    const basename = segments[segments.length - 1] ?? "";

    const isTestExt =
      basename.endsWith(".test.js") ||
      basename.endsWith(".test.ts") ||
      basename.endsWith(".test.jsx") ||
      basename.endsWith(".test.tsx") ||
      basename.endsWith(".test.mjs") ||
      basename.endsWith(".test.cjs") ||
      basename.endsWith(".spec.js") ||
      basename.endsWith(".spec.ts") ||
      basename.endsWith(".spec.jsx") ||
      basename.endsWith(".spec.tsx") ||
      basename.endsWith(".spec.mjs") ||
      basename.endsWith(".spec.cjs");

    if (isTestExt) {
      result.push(normalizeFilePath(file));
      continue;
    }

    const dirSegments = segments.slice(0, -1);
    if (
      dirSegments.some(
        (seg) => seg === "test" || seg === "tests" || seg === "__tests__"
      ) &&
      /\.[cm]?[jt]sx?$/.test(basename)
    ) {
      result.push(normalizeFilePath(file));
    }
  }
  return result;
}

/**
 * Helper to check if pytest --collect-only returned exit code 5 (no tests collected).
 * Requirement 11.10.
 */
export function isPytestCollectExitCode5(exitCode: number): boolean {
  return exitCode === 5;
}

/**
 * Creates the standard "No tests found" finding record with rule ID M13.
 * Requirement 11.10.
 */
export function createNoTestsFoundRecord(
  reason: string,
  language?: SupportedLanguage
): NoTestsFoundRecord {
  return {
    ruleId: NO_TESTS_FOUND_RULE_ID,
    title: NO_TESTS_FOUND_LABEL,
    status: NO_TESTS_FOUND_LABEL,
    reason,
    ...(language ? { language } : {}),
  };
}

/**
 * Evaluates pytest --collect-only exit code.
 * Requirement 11.10: Record "No tests found" with rule M13 when pytest collect returns exit code 5.
 */
export function evaluatePytestCollect(
  exitCode: number
): PytestCollectEvaluation {
  if (isPytestCollectExitCode5(exitCode)) {
    const reason = "pytest --collect-only exit code 5 (no tests collected)";
    return {
      noTestsFound: true,
      ruleId: NO_TESTS_FOUND_RULE_ID,
      label: NO_TESTS_FOUND_LABEL,
      reason,
      record: createNoTestsFoundRecord(reason, "python"),
      exitCode,
    };
  }

  return {
    noTestsFound: false,
    exitCode,
  };
}

/**
 * Detects whether Python dependencies should be installed with poetry or pip.
 * Requirement 11.7: Execute pip or poetry according to detected Python manifests.
 */
export function detectPythonPackageManager(
  manifests: readonly string[],
  pyprojectContent?: string
): "poetry" | "pip" {
  for (const m of manifests) {
    const norm = normalizeFilePath(m).toLowerCase();
    if (norm === "poetry.lock" || norm.endsWith("/poetry.lock")) {
      return "poetry";
    }
  }

  if (pyprojectContent && typeof pyprojectContent === "string") {
    if (
      /\[tool\.poetry\]/i.test(pyprojectContent) ||
      /build-backend\s*=\s*["']poetry\.core\.masonry\.api["']/i.test(
        pyprojectContent
      )
    ) {
      return "poetry";
    }
  }

  return "pip";
}

/**
 * Inspects Node manifest (package.json) and associated files.
 * Requirements: 11.5, 11.6, 11.8, 11.9, 11.10.
 */
export function inspectNodeManifest(
  packageJsonInput: PackageJson | string | Record<string, unknown> | null | undefined,
  fileList: readonly string[] = []
): NodeInspectionResult {
  const normFiles = fileList.map(normalizeFilePath);
  const pkg = parsePackageJson(packageJsonInput);

  const hasManifest =
    pkg !== null ||
    normFiles.some((f) => f === "package.json" || f.endsWith("/package.json"));

  // Check lock files
  const lockFiles = normFiles.filter((f) => {
    const base = f.split("/").pop() ?? "";
    return (
      base === "package-lock.json" ||
      base === "npm-shrinkwrap.json" ||
      base === "yarn.lock" ||
      base === "pnpm-lock.yaml"
    );
  });
  const lockFile = lockFiles[0];

  // Build script inspection (Requirement 11.9)
  const buildScript = pkg?.scripts?.build;
  let build: BuildInspectionResult;

  if (typeof buildScript === "string" && buildScript.trim().length > 0) {
    build = {
      hasBuildScript: true,
      script: buildScript.trim(),
      command: ["npm", "run", "build"],
      commandLine: "npm run build",
    };
  } else {
    build = {
      hasBuildScript: false,
      status: "not run",
      reason: "no build script",
    };
  }

  // Test script inspection (Requirement 11.10)
  const testScript = pkg?.scripts?.test;
  let test: TestInspectionResult;

  if (typeof testScript !== "string" || testScript.trim().length === 0) {
    const reason = "package.json has no test script";
    test = {
      hasTests: false,
      noTestsFound: true,
      ruleId: NO_TESTS_FOUND_RULE_ID,
      reason,
      record: createNoTestsFoundRecord(reason, "node"),
      isPlaceholder: false,
    };
  } else if (isDefaultPlaceholderTest(testScript)) {
    const reason = "package.json test script is default placeholder";
    test = {
      hasTests: false,
      noTestsFound: true,
      ruleId: NO_TESTS_FOUND_RULE_ID,
      reason,
      record: createNoTestsFoundRecord(reason, "node"),
      isPlaceholder: true,
    };
  } else {
    test = {
      hasTests: true,
      testCommand: ["npm", "test"],
      testCommandLine: "npm test",
      noTestsFound: false,
      isPlaceholder: false,
    };
  }

  // Install command (Requirement 11.6: pass --ignore-scripts; Requirement 11.8: retry)
  let installCommand: string[];
  let installRetryCommand: string[];

  const hasNpmLock =
    lockFile &&
    (lockFile.endsWith("package-lock.json") ||
      lockFile.endsWith("npm-shrinkwrap.json"));

  if (hasNpmLock) {
    installCommand = ["npm", "ci", "--ignore-scripts"];
    installRetryCommand = ["npm", "install", "--ignore-scripts"];
  } else {
    installCommand = ["npm", "install", "--ignore-scripts"];
    installRetryCommand = [
      "npm",
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
    ];
  }

  // Version commands (Requirement 11.5)
  const versionCommands: (readonly string[])[] = [
    ["node", "--version"],
    ["npm", "--version"],
  ];

  return {
    hasManifest,
    manifestPath: hasManifest ? "package.json" : undefined,
    packageManager: "npm",
    lockFile,
    build,
    test,
    installCommand,
    installRetryCommand,
    versionCommands,
  };
}

/**
 * Inspects Python manifests and test files.
 * Requirements: 11.5, 11.7, 11.8, 11.9, 11.10.
 */
export function inspectPythonManifests(
  fileListInput: FileListInput,
  pyprojectContent?: string,
  setupPyContent?: string
): PythonInspectionResult {
  const normFiles = extractFilePaths(fileListInput);

  const pyprojectActual =
    pyprojectContent ?? extractFileContent(fileListInput, "pyproject.toml");
  const setupPyActual =
    setupPyContent ?? extractFileContent(fileListInput, "setup.py");

  // Detect manifests
  const detectedManifests: string[] = [];
  const detectedLocks: string[] = [];

  for (const f of normFiles) {
    const base = f.split("/").pop() ?? "";
    if (
      base === "pyproject.toml" ||
      base === "setup.py" ||
      base === "setup.cfg" ||
      base === "Pipfile" ||
      (base.startsWith("requirements") && base.endsWith(".txt"))
    ) {
      detectedManifests.push(f);
    }
    if (base === "poetry.lock" || base === "Pipfile.lock") {
      detectedLocks.push(f);
    }
  }

  const hasManifest =
    detectedManifests.length > 0 ||
    pyprojectActual !== undefined ||
    setupPyActual !== undefined;

  const packageManager = detectPythonPackageManager(
    [...detectedManifests, ...detectedLocks],
    pyprojectActual
  );

  // Test inspection (Requirement 11.10: no test files -> No tests found with M13)
  const testFiles = findPythonTestFiles(normFiles);
  let test: TestInspectionResult;

  if (testFiles.length === 0) {
    const reason = "no test files found";
    test = {
      hasTests: false,
      noTestsFound: true,
      ruleId: NO_TESTS_FOUND_RULE_ID,
      reason,
      record: createNoTestsFoundRecord(reason, "python"),
      testFiles: [],
    };
  } else {
    test = {
      hasTests: true,
      testCommand: ["pytest"],
      testCommandLine: "pytest",
      noTestsFound: false,
      testFiles,
    };
  }

  // Build inspection (Requirement 11.9: no build script -> not run with reason)
  // Python repositories without a build script are marked not run
  let hasBuild = false;
  let buildScript: string | undefined;

  if (pyprojectActual && typeof pyprojectActual === "string") {
    if (
      /\[tool\.poetry\.scripts\]/i.test(pyprojectActual) &&
      /build\s*=/i.test(pyprojectActual)
    ) {
      hasBuild = true;
      buildScript = "poetry run build";
    }
  }

  let build: BuildInspectionResult;
  if (hasBuild && buildScript) {
    build = {
      hasBuildScript: true,
      script: buildScript,
      command: ["python3", "-m", "build"],
      commandLine: "python3 -m build",
    };
  } else {
    build = {
      hasBuildScript: false,
      status: "not run",
      reason: "no build script",
    };
  }

  // Install command (Requirement 11.7 & 11.8)
  let installCommand: string[];
  let installRetryCommand: string[];
  let versionCommands: (readonly string[])[];

  if (packageManager === "poetry") {
    installCommand = ["poetry", "install"];
    installRetryCommand = ["pip", "install", "."];
    versionCommands = [
      ["python3", "--version"],
      ["poetry", "--version"],
    ];
  } else {
    // pip
    const reqFile =
      detectedManifests.find(
        (m) =>
          normalizeFilePath(m) === "requirements.txt" ||
          normalizeFilePath(m).endsWith("/requirements.txt")
      ) ??
      detectedManifests.find((m) => {
        const b = m.split("/").pop() ?? "";
        return b.startsWith("requirements") && b.endsWith(".txt");
      });

    const hasSetup = detectedManifests.some((m) => {
      const b = m.split("/").pop() ?? "";
      return b === "setup.py" || b === "pyproject.toml";
    });

    if (reqFile) {
      installCommand = ["pip", "install", "-r", reqFile];
      installRetryCommand = hasSetup
        ? ["pip", "install", "-e", "."]
        : ["pip", "install", "."];
    } else if (hasSetup) {
      installCommand = ["pip", "install", "-e", "."];
      installRetryCommand = ["pip", "install", "."];
    } else {
      installCommand = ["pip", "install", "."];
      installRetryCommand = ["pip", "install", "--upgrade", "."];
    }

    versionCommands = [
      ["python3", "--version"],
      ["pip", "--version"],
    ];
  }

  return {
    hasManifest,
    manifests: detectedManifests,
    packageManager,
    lockFile: detectedLocks[0],
    build,
    test,
    installCommand,
    installRetryCommand,
    versionCommands,
  };
}

/**
 * Pure inspection function over file lists and manifests for Exhumer harness.
 * Inspects repository manifests across Node and Python, detecting install, build,
 * and test baseline scripts and requirements 11.4 - 11.10.
 */
export function inspectRepositoryManifests(
  input: FileListInput | ManifestInspectionInput
): ManifestInspectionResult {
  let fileListInput: FileListInput = [];
  let packageJsonInput: PackageJson | string | Record<string, unknown> | null | undefined;
  let pyprojectContent: string | undefined;
  let setupPyContent: string | undefined;

  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    !(input instanceof Map) &&
    ("files" in input || "packageJson" in input || "pyprojectToml" in input)
  ) {
    const obj = input as ManifestInspectionInput;
    fileListInput = obj.files ?? [];
    packageJsonInput = obj.packageJson;
    if (typeof obj.pyprojectToml === "string") {
      pyprojectContent = obj.pyprojectToml;
    }
    if (typeof obj.setupPy === "string") {
      setupPyContent = obj.setupPy;
    }
  } else {
    fileListInput = input as FileListInput;
  }

  const filePaths = extractFilePaths(fileListInput);

  if (packageJsonInput === undefined) {
    const pkgContent = extractFileContent(fileListInput, "package.json");
    if (pkgContent) {
      packageJsonInput = pkgContent;
    }
  }

  // Detect languages
  const hasNode =
    packageJsonInput !== undefined ||
    filePaths.some(
      (f) =>
        f === "package.json" ||
        f.endsWith("/package.json") ||
        /\.[cm]?[jt]sx?$/.test(f)
    );

  const hasPython =
    pyprojectContent !== undefined ||
    setupPyContent !== undefined ||
    filePaths.some(
      (f) =>
        f === "pyproject.toml" ||
        f.endsWith("/pyproject.toml") ||
        f === "setup.py" ||
        f.endsWith("/setup.py") ||
        f === "Pipfile" ||
        (f.split("/").pop()?.startsWith("requirements") && f.endsWith(".txt")) ||
        f.endsWith(".py")
    );

  const languages: SupportedLanguage[] = [];
  if (hasNode) languages.push("node");
  if (hasPython) languages.push("python");

  let nodeResult: NodeInspectionResult | undefined;
  let pythonResult: PythonInspectionResult | undefined;

  if (hasNode) {
    nodeResult = inspectNodeManifest(packageJsonInput, filePaths);
  }
  if (hasPython) {
    pythonResult = inspectPythonManifests(
      fileListInput,
      pyprojectContent,
      setupPyContent
    );
  }

  // Determine primary language and manifest files
  const manifestFiles: string[] = [];
  const lockFiles: string[] = [];

  if (nodeResult?.hasManifest) {
    manifestFiles.push("package.json");
    if (nodeResult.lockFile) lockFiles.push(nodeResult.lockFile);
  }
  if (pythonResult?.hasManifest) {
    manifestFiles.push(...pythonResult.manifests);
    if (pythonResult.lockFile) lockFiles.push(pythonResult.lockFile);
  }

  let primaryLanguage: SupportedLanguage | "unknown" = "unknown";
  if (languages.length === 1) {
    primaryLanguage = languages[0];
  } else if (languages.length > 1) {
    // If both exist, prioritize whichever has root manifest
    if (nodeResult?.hasManifest) {
      primaryLanguage = "node";
    } else if (pythonResult?.hasManifest) {
      primaryLanguage = "python";
    } else {
      primaryLanguage = languages[0];
    }
  }

  // Default fallbacks when no manifests exist
  let packageManager: "npm" | "pip" | "poetry" | "unknown" = "unknown";
  let versionCommands: readonly (readonly string[])[] = [];
  let installCommand: readonly string[] = [];
  let installRetryCommand: readonly string[] | undefined;
  let build: BuildInspectionResult;
  let test: TestInspectionResult;

  if (primaryLanguage === "node" && nodeResult) {
    packageManager = nodeResult.packageManager;
    versionCommands = nodeResult.versionCommands;
    installCommand = nodeResult.installCommand;
    installRetryCommand = nodeResult.installRetryCommand;
    build = nodeResult.build;
    test = nodeResult.test;
  } else if (primaryLanguage === "python" && pythonResult) {
    packageManager = pythonResult.packageManager;
    versionCommands = pythonResult.versionCommands;
    installCommand = pythonResult.installCommand;
    installRetryCommand = pythonResult.installRetryCommand;
    build = pythonResult.build;
    test = pythonResult.test;
  } else {
    // Unknown or unmanifested
    build = {
      hasBuildScript: false,
      status: "not run",
      reason: "no build script",
    };
    const reason = "no test script or test files found";
    test = {
      hasTests: false,
      noTestsFound: true,
      ruleId: NO_TESTS_FOUND_RULE_ID,
      reason,
      record: createNoTestsFoundRecord(reason),
    };
  }

  return {
    languages,
    primaryLanguage,
    manifestFiles,
    lockFiles,
    packageManager,
    versionCommands,
    installCommand,
    installRetryCommand,
    build,
    test,
    ...(nodeResult ? { node: nodeResult } : {}),
    ...(pythonResult ? { python: pythonResult } : {}),
  };
}

/**
 * Helper implementing Requirement 11.8:
 * If install fails and retry with the other command also fails,
 * mark build and tests as "not run".
 */
export function markStepsNotRunOnInstallFailure(
  installFailed: boolean,
  retryFailed: boolean
): { buildStatus: "not run"; testStatus: "not run"; reason: string } | null {
  if (installFailed && retryFailed) {
    return {
      buildStatus: "not run",
      testStatus: "not run",
      reason: "install failed and install retry failed",
    };
  }
  return null;
}
