// lib/merge/candidate-hash.ts
// Requirements: 9.12, 25.6, 25.7, 25.8

import * as crypto from "node:crypto";

/**
 * Returns the lowercase hex SHA-256 of the exact diff text.
 */
export function candidateSha256FromDiff(diffText: string): string {
  if (typeof diffText !== "string") {
    return "";
  }
  return crypto.createHash("sha256").update(diffText).digest("hex").toLowerCase();
}
