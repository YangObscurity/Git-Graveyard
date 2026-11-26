// Work package SC5: host isolation allowlist and checksum hardening (audit N-C9)
// The egress allowlist refuses any entry with prefix length 0 (0.0.0.0/0, ::/0).
// The expected SHA-256 must be exactly 64 hexadecimal characters and is compared
// as a whole value against the release manifest, never as a substring.

import * as assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/host-isolation.sh");

describe("Work package SC5: host-isolation.sh allowlist and checksum hardening (N-C9)", () => {
  const scriptContent = fs.readFileSync(SCRIPT_PATH, "utf-8");

  describe("Allowlist prefix length 0", () => {
    // Extract the validation functions and the allowlist processing loop from
    // host-isolation.sh and run them against a temporary allowlist file.
    function extractAllowlistParts(): { functions: string; loop: string } {
      const matchFunctions = scriptContent.match(
        /is_valid_ipv4\(\) \{[\s\S]*?is_valid_hostname\(\) \{[\s\S]*?\n\}/
      );
      assert.ok(matchFunctions, "Validation functions must be present in host-isolation.sh");

      const matchAllowlist = scriptContent.match(
        /allow_rules=""[\s\S]*?done < "\$ALLOWLIST_FILE"\s*\nfi/
      );
      assert.ok(matchAllowlist, "Allowlist processing loop must be present");

      return { functions: matchFunctions[0], loop: matchAllowlist[0] };
    }

    function runAllowlistLoop(entries: string) {
      const { functions, loop } = extractAllowlistParts();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-iso-sc5-"));
      try {
        const allowlistFile = path.join(tempDir, "allowlist.txt");
        fs.writeFileSync(allowlistFile, entries, "utf-8");

        const bashCode = `
set -euo pipefail
SKEL_UID=1001
ALLOWLIST_FILE="${allowlistFile}"
${functions}
${loop}
echo -n "$allow_rules"
`;
        return child_process.spawnSync("bash", ["-c", bashCode], {
          encoding: "utf-8",
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    it("0.0.0.0/0 is refused", () => {
      const res = runAllowlistLoop("0.0.0.0/0\n");
      assert.notEqual(
        res.status,
        0,
        "Expected non-zero exit for allowlist entry 0.0.0.0/0"
      );
      assert.notEqual(res.stderr.trim(), "", "An error must be reported for 0.0.0.0/0");
      assert.equal(
        (res.stdout || "").includes("daddr"),
        false,
        "No accept rule may be written for 0.0.0.0/0"
      );
    });

    it("::/0 is refused", () => {
      const res = runAllowlistLoop("::/0\n");
      assert.notEqual(
        res.status,
        0,
        "Expected non-zero exit for allowlist entry ::/0"
      );
      assert.notEqual(res.stderr.trim(), "", "An error must be reported for ::/0");
      assert.equal(
        (res.stdout || "").includes("daddr"),
        false,
        "No accept rule may be written for ::/0"
      );
    });

    it("entries without prefix length 0 are still accepted", () => {
      const res = runAllowlistLoop("10.1.2.0/24\n");
      assert.equal(
        res.status,
        0,
        `Allowlist entry 10.1.2.0/24 must still be accepted: ${res.stderr}`
      );
      assert.ok(
        (res.stdout || "").includes("skuid 1001 ip daddr 10.1.2.0/24 accept"),
        "The /24 entry must produce its accept rule"
      );
    });
  });

  describe("Expected SHA verification", () => {
    // Extract the checksum verification section (normalization, format check and
    // whole-value manifest comparison) from host-isolation.sh.
    function extractChecksumSection(): string {
      const matchSection = scriptContent.match(
        /normalized_expected="\$\(echo "\$EXPECTED_SHA256"[\s\S]*?(?=echo "Verified: kiro-cli)/
      );
      assert.ok(matchSection, "Checksum verification section must be present in host-isolation.sh");
      return matchSection[0];
    }

    function runChecksumVerification(expectedSha: string, manifestContent: string) {
      const bashCode = `
set -euo pipefail
EXPECTED_SHA256="${expectedSha}"
manifest_content="${manifestContent}"
${extractChecksumSection()}
`;
      return child_process.spawnSync("bash", ["-c", bashCode], {
        encoding: "utf-8",
      });
    }

    const sha64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    it("an 8-character SHA is refused", () => {
      // The manifest contains the 64-character checksum that starts with the
      // 8-character value, so a substring comparison would have matched.
      const res = runChecksumVerification(sha64.slice(0, 8), `${sha64}\n`);
      assert.notEqual(
        res.status,
        0,
        "Expected non-zero exit for an 8-character expected SHA"
      );
      assert.notEqual(res.stderr.trim(), "", "An error must be reported for an 8-character SHA");
    });

    it("a 64-character SHA is accepted", () => {
      const res = runChecksumVerification(sha64, `${sha64}\n`);
      assert.equal(
        res.status,
        0,
        `A 64-character expected SHA found as a whole line must verify: ${res.stderr}`
      );
    });

    it("the SHA is compared as a whole value, not as a substring", () => {
      // The checksum embedded in a longer line must not count as verified.
      const asHexSubstring = runChecksumVerification(sha64, `${sha64}ff\n`);
      assert.notEqual(
        asHexSubstring.status,
        0,
        "A checksum that appears only as a substring of a longer hex line must be refused"
      );

      const asLineSubstring = runChecksumVerification(
        sha64,
        `prefix_${sha64}  kiro-cli-3.1.0.tar.gz\n`
      );
      assert.notEqual(
        asLineSubstring.status,
        0,
        "A checksum that appears only as a substring of a longer manifest line must be refused"
      );
    });
  });
});
