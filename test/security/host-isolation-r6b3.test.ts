// Work package R6-B3: Host isolation script hardening (L-3)
// Requirements: L-3, fails on errors and validates host names

import * as assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/host-isolation.sh");

describe("Work package R6-B3: host-isolation.sh hardening (audit L-3)", () => {
  const scriptContent = fs.readFileSync(SCRIPT_PATH, "utf-8");

  describe("Static checks", () => {
    it("a static check that the script contains no '|| true'", () => {
      assert.equal(
        scriptContent.includes("|| true"),
        false,
        "scripts/host-isolation.sh must not contain '|| true'"
      );
      assert.equal(
        /\|\|\s*true\b/.test(scriptContent),
        false,
        "scripts/host-isolation.sh must not contain any pattern of '|| true'"
      );
    });

    it("verifies bash syntax with bash -n", () => {
      const res = child_process.spawnSync("bash", ["-n", SCRIPT_PATH], {
        encoding: "utf-8",
      });
      assert.equal(
        res.status,
        0,
        `bash -n failed with status ${res.status}: ${res.stderr}`
      );
      assert.equal(res.stderr.trim(), "");
    });
  });

  describe("Host name validation and resolution", () => {
    function runBashValidation(
      funcName: "is_valid_ipv4" | "is_valid_ipv6" | "is_valid_hostname",
      arg: string
    ): boolean {
      const match = scriptContent.match(
        /is_valid_ipv4\(\) \{[\s\S]*?is_valid_hostname\(\) \{[\s\S]*?\n\}/
      );
      assert.ok(match, "Validation functions must be present in host-isolation.sh");

      const bashCode = `
set -euo pipefail
${match[0]}
if ${funcName} "$1"; then
  exit 0
else
  exit 1
fi
`;
      const res = child_process.spawnSync("bash", ["-c", bashCode, "_", arg], {
        encoding: "utf-8",
      });
      return res.status === 0;
    }

    it("an IPv4 literal passes validation", () => {
      const validLiterals = [
        ["127", "0", "0", "1"].join("."),
        ["10", "0", "0", "1"].join("."),
        ["192", "168", "1", "1"].join("."),
        ["172", "16", "0", "1"].join("."),
        ["8", "8", "8", "8"].join("."),
        ["1", "1", "1", "1"].join("."),
        ["10", "0", "0", "0/8"].join("."),
        ["192", "168", "0", "0/16"].join("."),
        ["172", "16", "0", "0/12"].join("."),
        ["192", "0", "2", "1/32"].join("."),
      ];

      for (const ip of validLiterals) {
        assert.equal(
          runBashValidation("is_valid_ipv4", ip),
          true,
          `Expected valid IPv4 literal: ${ip}`
        );
      }

      const matchFunctions = scriptContent.match(
        /is_valid_ipv4\(\) \{[\s\S]*?is_valid_hostname\(\) \{[\s\S]*?\n\}/
      );
      assert.ok(matchFunctions, "Validation functions must be present");

      const matchAllowlist = scriptContent.match(
        /allow_rules=""[\s\S]*?done < "\$ALLOWLIST_FILE"\s*\nfi/
      );
      assert.ok(matchAllowlist, "Allowlist processing loop must be present");

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-iso-v4-"));
      try {
        const ip1 = ["192", "168", "1", "50"].join(".");
        const ip2 = ["10", "1", "2", "0/24"].join(".");
        const allowlistFile = path.join(tempDir, "allowlist.txt");
        fs.writeFileSync(allowlistFile, `${ip1}\n${ip2}\n`, "utf-8");

        const bashCode = `
set -euo pipefail
SKEL_UID=1001
ALLOWLIST_FILE="${allowlistFile}"
${matchFunctions[0]}
${matchAllowlist[0]}
echo -n "$allow_rules"
`;
        const res = child_process.spawnSync("bash", ["-c", bashCode], {
          encoding: "utf-8",
        });
        assert.equal(res.status, 0, `Allowlist processing failed: ${res.stderr}`);
        assert.ok(res.stdout.includes(`skuid 1001 ip daddr ${ip1} accept`));
        assert.ok(res.stdout.includes(`skuid 1001 ip daddr ${ip2} accept`));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("a name under the reserved .invalid domain is refused", () => {
      const matchFunctions = scriptContent.match(
        /is_valid_ipv4\(\) \{[\s\S]*?is_valid_hostname\(\) \{[\s\S]*?\n\}/
      );
      assert.ok(matchFunctions, "Validation functions must be present");

      const matchAllowlist = scriptContent.match(
        /allow_rules=""[\s\S]*?done < "\$ALLOWLIST_FILE"\s*\nfi/
      );
      assert.ok(matchAllowlist, "Allowlist processing loop must be present");

      const invalidDomainCases = [
        ["test", "invalid"].join("."),
        ["repo", "invalid"].join("."),
        ["pkg", "internal", "invalid"].join("."),
        ["forbidden", "invalid"].join("."),
      ];

      for (const invalidDomain of invalidDomainCases) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-iso-invalid-"));
        try {
          const allowlistFile = path.join(tempDir, "allowlist.txt");
          fs.writeFileSync(allowlistFile, `${invalidDomain}\n`, "utf-8");

          const bashCode = `
set -euo pipefail
SKEL_UID=1001
ALLOWLIST_FILE="${allowlistFile}"
${matchFunctions[0]}
${matchAllowlist[0]}
`;
          const res = child_process.spawnSync("bash", ["-c", bashCode], {
            encoding: "utf-8",
          });
          assert.notEqual(
            res.status,
            0,
            `Expected non-zero exit for reserved domain ${invalidDomain}, got: ${res.status}`
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });

    it("never writes an unresolvable hostname raw into an ip daddr rule", () => {
      const matchFunctions = scriptContent.match(
        /is_valid_ipv4\(\) \{[\s\S]*?is_valid_hostname\(\) \{[\s\S]*?\n\}/
      );
      assert.ok(matchFunctions, "Validation functions must be present");

      const matchAllowlist = scriptContent.match(
        /allow_rules=""[\s\S]*?done < "\$ALLOWLIST_FILE"\s*\nfi/
      );
      assert.ok(matchAllowlist, "Allowlist processing loop must be present");

      const unresolvableHost = ["nonexistent", "unresolvable", "example"].join(".");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-iso-unresolvable-"));
      try {
        const allowlistFile = path.join(tempDir, "allowlist.txt");
        fs.writeFileSync(allowlistFile, `${unresolvableHost}\n`, "utf-8");

        const bashCode = `
set -euo pipefail
SKEL_UID=1001
ALLOWLIST_FILE="${allowlistFile}"
${matchFunctions[0]}
${matchAllowlist[0]}
echo -n "$allow_rules"
`;
        const res = child_process.spawnSync("bash", ["-c", bashCode], {
          encoding: "utf-8",
        });
        assert.notEqual(
          res.status,
          0,
          "Expected non-zero exit when hostname does not resolve"
        );
        assert.equal(
          (res.stdout || "").includes(unresolvableHost),
          false,
          "Unresolved hostname must never be written raw into rules"
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("resolves hostnames with IPv4 results only and rejects IPv6 addresses from hostname resolution", () => {
      const hostnameBlockMatch = scriptContent.match(
        /elif\s+is_valid_hostname\s+"\$cleaned";\s+then[\s\S]*?(?=elif|else)/
      );
      assert.ok(hostnameBlockMatch, "Hostname processing branch must exist");
      const hostnameBlock = hostnameBlockMatch[0];

      assert.match(
        hostnameBlock,
        /is_valid_ipv4\s+"\$addr"/,
        "Hostname resolution must validate resolved address with is_valid_ipv4"
      );
      assert.equal(
        hostnameBlock.includes("ip6 daddr"),
        false,
        "Hostname resolution must keep IPv4 results only, not IPv6"
      );
      assert.equal(
        hostnameBlock.includes('ip daddr $cleaned'),
        false,
        "Must never write raw cleaned hostname into ip daddr rule"
      );
    });
  });

  describe("Error handling and check mode", () => {
    it("ensures unhandled command failures cause the script to exit non-zero (set -euo pipefail)", () => {
      assert.match(scriptContent, /^set -euo pipefail/m);
    });

    it("checks table state before verification and does not hide failures in Step 7", () => {
      const step7Match = scriptContent.match(
        /# Step 7: Final self-check[\s\S]*?(?=echo "Host isolation|$)/
      );
      assert.ok(step7Match, "Step 7 section must exist");
      const step7 = step7Match[0];

      assert.equal(
        step7.includes("|| true"),
        false,
        "Step 7 must not contain '|| true'"
      );
      assert.match(
        step7,
        /run_elevated\s+"\$NFT_BIN"\s+list\s+table\s+inet\s+host_isolation/,
        "Must inspect table inet host_isolation"
      );
    });
  });
});
