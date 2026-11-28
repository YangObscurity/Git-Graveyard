#!/usr/bin/env tsx
// WP-29 Task 29.3: XR-01 / XR-02 / XR-03 verifier CLI (plus library re-exports).
//
// Reads a JSON input describing the observed sandbox teardown, kill-switch levels and
// push/write refusal attempts, runs the three verifiers and prints a structured result.
// Exit status is `0` only when every extension item passes.

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  type XRVerificationInput,
  type XRVerificationResult,
  runXRVerifiers,
  verifyXR01,
  verifyXR02,
  verifyXR03,
} from "../../lib/audit/xr-verifier";

export {
  runXRVerifiers,
  verifyXR01,
  verifyXR02,
  verifyXR03,
  type XRVerificationInput,
  type XRVerificationResult,
};

const USAGE = `Usage: verify-xr-items --input <file.json>

The input JSON must be an object with 'xr01', 'xr02' and 'xr03' members matching the
verifier input shapes in lib/audit/xr-verifier.ts.

  --input <file.json>   Path to the verifier input JSON.
  --help                Show this help.`;

interface CliArgs {
  inputPath?: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("Missing value for --input");
      }
      i += 1;
      args.inputPath = next;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!args.inputPath) {
    process.stderr.write(`Missing required --input <file.json>.\n\n${USAGE}\n`);
    return 2;
  }

  const raw = fs.readFileSync(path.resolve(args.inputPath), "utf8");
  const input = JSON.parse(raw) as XRVerificationInput;
  const result = runXRVerifiers(input);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.ok,
        verdicts: result.verdicts.map((verdict) => ({
          id: verdict.id,
          ok: verdict.ok,
          summary: verdict.summary,
          failures: verdict.failures,
        })),
      },
      null,
      2
    )}\n`
  );
  return result.ok ? 0 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    });
}