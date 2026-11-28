#!/usr/bin/env tsx
// WP-29 Task 29.4: Credential rotation verifier (CLI + library).
//
// Compares production vs development credential fingerprints (SHA-256 digests) to verify
// every production credential (Kiro key, sandbox key, invite codes, GitHub tokens) is
// fresh and distinct from its development counterpart, and that revoked development
// credentials fail post-promotion authentication probes. Raw credential strings are
// NEVER logged or persisted — only their SHA-256 fingerprints and pass/fail booleans.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** SHA-256 hex digest of a credential. The raw value is never returned or logged. */
export function fingerprintCredential(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export interface CredentialPair {
  /** Logical name, e.g. `kiro_key`, `sandbox_key`, `invite_codes`, `github_token`. */
  name: string;
  dev: string;
  prod: string;
}

export interface RevokedDevProbe {
  name: string;
  /** The revoked development credential. */
  devCredential: string;
  /** Returns true when the credential still authenticates (must be false post-promotion). */
  authProbe: (credential: string) => boolean;
}

export interface RevokedDevCredential {
  name: string;
  /** The revoked development credential (only its fingerprint is ever surfaced). */
  credential: string;
}

export interface CredentialRotationInput {
  pairs: readonly CredentialPair[];
  /** Live authentication probes for revoked dev credentials (must reject). */
  revokedProbes?: readonly RevokedDevProbe[];
  /** Offline revoked dev credentials judged by fingerprint against active prod creds. */
  revokedCredentials?: readonly RevokedDevCredential[];
}

export interface CredentialFingerprint {
  name: string;
  devFingerprint: string;
  prodFingerprint: string;
  distinct: boolean;
  fresh: boolean;
}

export interface CredentialRotationResult {
  ok: boolean;
  fingerprints: CredentialFingerprint[];
  revoked: Array<{ name: string; rejected: boolean }>;
  failures: string[];
}

/**
 * Verifies credential rotation. Returns only fingerprints and booleans; the raw
 * credential strings never appear in the result.
 */
export function verifyCredentialRotation(
  input: CredentialRotationInput
): CredentialRotationResult {
  const failures: string[] = [];
  const pairs = Array.isArray(input?.pairs) ? input.pairs : [];
  const fingerprints: CredentialFingerprint[] = [];
  const prodFingerprints = new Set<string>();

  if (pairs.length === 0) {
    failures.push("No credential pairs were supplied, so rotation cannot be verified.");
  }

  for (const pair of pairs) {
    if (!pair || typeof pair.name !== "string") {
      failures.push("Encountered a credential pair without a name.");
      continue;
    }
    const dev = typeof pair.dev === "string" ? pair.dev : "";
    const prod = typeof pair.prod === "string" ? pair.prod : "";
    if (dev.length === 0) {
      failures.push(`Credential '${pair.name}' has no development value.`);
    }
    if (prod.length === 0) {
      failures.push(`Credential '${pair.name}' has no production value.`);
    }
    const devFingerprint = dev.length > 0 ? fingerprintCredential(dev) : "";
    const prodFingerprint = prod.length > 0 ? fingerprintCredential(prod) : "";
    if (prodFingerprint) {
      prodFingerprints.add(prodFingerprint);
    }
    const distinct = devFingerprint !== "" && prodFingerprint !== "" && devFingerprint !== prodFingerprint;
    if (!distinct) {
      failures.push(
        `Credential '${pair.name}' production value is not distinct from development.`
      );
    }
    fingerprints.push({
      name: pair.name,
      devFingerprint,
      prodFingerprint,
      distinct,
      fresh: distinct,
    });
  }

  const revoked: Array<{ name: string; rejected: boolean }> = [];

  for (const probe of Array.isArray(input?.revokedProbes) ? input.revokedProbes : []) {
    if (!probe || typeof probe.name !== "string") {
      continue;
    }
    let rejected: boolean;
    try {
      // A revoked dev credential must FAIL authentication (probe returns false).
      rejected = probe.authProbe(probe.devCredential) === false;
    } catch {
      // A throwing probe fails closed and counts as rejected.
      rejected = true;
    }
    if (!rejected) {
      failures.push(
        `Revoked development credential '${probe.name}' still authenticates post-promotion.`
      );
    }
    revoked.push({ name: probe.name, rejected });
  }

  for (const entry of Array.isArray(input?.revokedCredentials)
    ? input.revokedCredentials
    : []) {
    if (!entry || typeof entry.name !== "string") {
      continue;
    }
    const credential = typeof entry.credential === "string" ? entry.credential : "";
    const fp = credential.length > 0 ? fingerprintCredential(credential) : "";
    // A revoked dev credential is rejected when it no longer matches any active prod cred.
    const rejected = fp !== "" && !prodFingerprints.has(fp);
    if (!rejected) {
      failures.push(
        `Revoked development credential '${entry.name}' still matches an active production credential.`
      );
    }
    revoked.push({ name: entry.name, rejected });
  }

  if (revoked.length === 0) {
    failures.push("No revoked development credentials were checked.");
  }

  return { ok: failures.length === 0, fingerprints, revoked, failures };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: verify-credentials --input <file.json>

The input JSON must be an object with:
  - pairs:        [{ name, dev, prod }, ...]
  - revokedCredentials: [{ name, credential }, ...]   (offline fingerprint check)

Only SHA-256 fingerprints and pass/fail booleans are printed; raw credentials never are.

  --input <file.json>   Path to the rotation input JSON.
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
  const input = JSON.parse(raw) as CredentialRotationInput;
  const result = verifyCredentialRotation(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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