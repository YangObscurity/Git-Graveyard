#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PROTECTED_DIRS = [
  "test/golden",
  ".kiro/specs/resurrection",
  "test/fixtures/pinned",
  ".cache"
];

const ALLOWED_DIRS = [
  ".agent-ws",
  "output"
];

function getTargetPath(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const ti = payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.arguments ?? payload.params;
  if (ti && typeof ti === "object") {
    const val = ti.path ?? ti.file_path ?? ti.target;
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }

  const fallback = payload.path ?? payload.file_path ?? payload.target;
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return fallback.trim();
  }

  return null;
}

function checkProtection(targetPath) {
  let p = targetPath.replace(/\\/g, "/");

  const repoRoot = path.resolve(import.meta.dirname, "../..");
  if (path.isAbsolute(p)) {
    const relCwd = path.relative(process.cwd(), p).replace(/\\/g, "/");
    if (!relCwd.startsWith("../")) {
      p = relCwd;
    } else {
      const relRepo = path.relative(repoRoot, p).replace(/\\/g, "/");
      if (!relRepo.startsWith("../")) {
        p = relRepo;
      }
    }
  }

  p = path.posix.normalize(p).replace(/^\/+/, "");
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  const clean = p.replace(/\/+$/, "");

  for (const dir of ALLOWED_DIRS) {
    if (clean === dir || clean.startsWith(dir + "/")) {
      return { protected: false, clean };
    }
  }

  for (const dir of PROTECTED_DIRS) {
    if (clean === dir || clean.startsWith(dir + "/")) {
      return { protected: true, clean };
    }
  }

  return { protected: false, clean };
}

function main() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  if (!raw.trim()) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const targetPath = getTargetPath(payload);
  if (!targetPath) {
    process.exit(0);
  }

  const result = checkProtection(targetPath);
  if (result.protected) {
    process.stderr.write(`Blocked write to protected path: ${result.clean}\n`);
    process.exit(2);
  }

  process.exit(0);
}

main();
