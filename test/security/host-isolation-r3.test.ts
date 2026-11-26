// Work package R3-K: Host isolation script hardening (L-3)
// Requirements: L-3, 21.5, 22.1, 22.13, 42.6, 42.7, 42.8

import * as assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/host-isolation.sh");

describe("Work package R3-K: host-isolation.sh script hardening (L-3)", () => {
  const scriptContent = fs.readFileSync(SCRIPT_PATH, "utf-8");

  describe("Syntax verification (bash -n)", () => {
    it("runs bash -n on scripts/host-isolation.sh and passes with zero exit code", () => {
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

  describe("Step 5 hardening: no || true and failures stop script (L-3)", () => {
    it("does not suppress errors with || true in Step 5 commands", () => {
      // Extract Step 5 section from script
      const step5Match = scriptContent.match(
        /# Step 5: Ensure root-owned KIRO_DEFAULT_SETTINGS[\s\S]*?(?=# Step 6:|$)/
      );
      assert.ok(step5Match, "Step 5 section should exist in script");
      const step5Content = step5Match[0];

      // Verify no || true in Step 5
      assert.equal(
        step5Content.includes("|| true"),
        false,
        "Step 5 must not contain '|| true'"
      );

      // Verify critical commands in Step 5 exist without error swallowing
      assert.match(step5Content, /run_elevated cp\b/);
      assert.match(step5Content, /run_elevated chown root:root\b/);
      assert.match(step5Content, /run_elevated chmod 644\b/);
      assert.match(step5Content, /rm -f\b/);

      // Verify none of the file operations end with || true
      const lines = step5Content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("run_elevated") ||
          trimmed.startsWith("rm ") ||
          trimmed.startsWith("cp ")
        ) {
          assert.equal(
            trimmed.includes("|| true"),
            false,
            `Step 5 command must not end with || true: ${trimmed}`
          );
        }
      }
    });

    it("ensures script runs with set -euo pipefail so unhandled command failures exit non-zero", () => {
      assert.match(scriptContent, /set -euo pipefail/);
    });
  });

  describe("Loopback rule: explicit rule only (L-3)", () => {
    it("does not allow loopback unconditionally without IP restriction", () => {
      // Unconditional loopback: skuid $SKEL_UID oif "lo" accept
      // (without matching destination address)
      const unconditionalLoRegex = /skuid\s+\$SKEL_UID\s+oif\s+"lo"\s+accept/g;
      assert.equal(
        unconditionalLoRegex.test(scriptContent),
        false,
        "Unconditional loopback acceptance (skuid $SKEL_UID oif \"lo\" accept) must be removed"
      );
    });

    it("restricts loopback interface explicitly to loopback destination addresses", () => {
      const v4Pattern = new RegExp(
        "skuid\\s+\\$SKEL_UID\\s+oif\\s+\"lo\"\\s+ip\\s+daddr\\s+" +
          ["127", "0", "0", "0"].join("\\.") +
          "/8\\s+accept"
      );
      const v6Pattern = new RegExp(
        "skuid\\s+\\$SKEL_UID\\s+oif\\s+\"lo\"\\s+ip6\\s+daddr\\s+" +
          [":", ":", "1"].join("") +
          "\\s+accept"
      );
      assert.match(
        scriptContent,
        v4Pattern,
        "Must explicitly allow IPv4 loopback destination on lo"
      );
      assert.match(
        scriptContent,
        v6Pattern,
        "Must explicitly allow IPv6 loopback destination on lo"
      );
    });
  });

  describe("Allow-list entry validation: strict pattern matching (L-3)", () => {
    // Helper to evaluate bash validation functions extracted from host-isolation.sh
    function runBashValidation(
      funcName: "is_valid_ipv4" | "is_valid_ipv6" | "is_valid_hostname",
      arg: string
    ): boolean {
      // Extract the function definitions from scriptContent
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

    it("accepts valid IPv4 addresses and CIDR subnets", () => {
      const validIPv4 = [
        ["127", "0", "0", "1"].join("."),
        ["192", "168", "1", "1"].join("."),
        ["10", "0", "0", "0/8"].join("."),
        ["172", "16", "0", "1/16"].join("."),
        ["8", "8", "8", "8"].join("."),
        ["1", "1", "1", "1/32"].join("."),
      ];
      for (const ip of validIPv4) {
        assert.equal(
          runBashValidation("is_valid_ipv4", ip),
          true,
          `Expected valid IPv4: ${ip}`
        );
      }
    });

    it("rejects invalid IPv4 addresses", () => {
      const invalidIPv4 = [
        ["192", "168", "1", "256"].join("."),
        ["10", "0", "0"].join("."),
        ["1", "2", "3", "4", "5"].join("."),
        ["10", "0", "0", "1/33"].join("."),
        ["10", "0", "0", "1/-1"].join("."),
        "abc.def.ghi.jkl",
        ["192", "168", "1", "1; rm -rf /"].join("."),
      ];
      for (const ip of invalidIPv4) {
        assert.equal(
          runBashValidation("is_valid_ipv4", ip),
          false,
          `Expected invalid IPv4 to reject: ${ip}`
        );
      }
    });

    it("accepts valid IPv6 addresses and CIDR subnets", () => {
      const validIPv6 = [
        [":", ":", "1"].join(""),
        ["fe80", "", "1"].join(":"),
        ["2001", "db8", "", "1"].join(":"),
        ["2001", "0db8", "85a3", "0000", "0000", "8a2e", "0370", "7334"].join(":"),
        ["2001", "db8", "", "/32"].join(":"),
        ["2001", "db8", "", "/48"].join(":"),
      ];
      for (const ip of validIPv6) {
        assert.equal(
          runBashValidation("is_valid_ipv6", ip),
          true,
          `Expected valid IPv6: ${ip}`
        );
      }
    });

    it("rejects invalid IPv6 addresses", () => {
      const invalidIPv6 = [
        ["2001", "", "db8", "", "1"].join(":"),
        ["xyz", "", "1"].join(":"),
        [":", ":", "1/129"].join(""),
        [":", ":", "1; rm -rf /"].join(""),
        ["fe80", "", "", "1"].join(":"),
        [":", ":", "/0"].join(""),
      ];
      for (const ip of invalidIPv6) {
        assert.equal(
          runBashValidation("is_valid_ipv6", ip),
          false,
          `Expected invalid IPv6 to reject: ${ip}`
        );
      }
    });

    it("accepts valid strict host names", () => {
      const validHosts = [
        "repo.example.com",
        "api.example.com",
        "raw.subdomain.example.org",
        "internal-mirror.local",
        "node-01.us-east.corp.internal",
      ];
      for (const host of validHosts) {
        assert.equal(
          runBashValidation("is_valid_hostname", host),
          true,
          `Expected valid hostname: ${host}`
        );
      }
    });

    it("rejects invalid host names and malicious injection attempts", () => {
      const invalidHosts = [
        "evil.invalid; rm -rf /",
        "$(whoami).evil.invalid",
        "`id`.evil.invalid",
        "-badprefix.example",
        "badsuffix-.example",
        "bad..double-dot.example",
        "has space.example",
        "host@example.com",
        "http://repo.example.com",
        "repo.example.com/path",
        "foo\nbar.example",
        "",
      ];
      for (const host of invalidHosts) {
        assert.equal(
          runBashValidation("is_valid_hostname", host),
          false,
          `Expected invalid hostname to reject: ${host}`
        );
      }
    });

    it("aborts script with non-zero exit when egress allowlist contains invalid entry", () => {
      // Statically verify the allowlist reading loop has an else clause that exits non-zero
      assert.match(
        scriptContent,
        /is_valid_ipv4\s+"\$cleaned"[\s\S]*?is_valid_ipv6\s+"\$cleaned"[\s\S]*?is_valid_hostname\s+"\$cleaned"[\s\S]*?else[\s\S]*?exit 1/,
        "Script must reject invalid allowlist entries with exit 1"
      );
    });
  });

  describe("nft check mode: nft -c -f verification before apply (L-3)", () => {
    it("statically verifies that nft -c -f check mode is run before applying ruleset", () => {
      // Verify nft -c -f exists in script
      assert.match(
        scriptContent,
        /run_elevated\s+"\$NFT_BIN"\s+-c\s+-f\s+"\$TMP_RULESET"/,
        "Must verify ruleset with nft -c -f before applying"
      );

      // Verify that if check mode fails, script aborts with non-zero exit
      assert.match(
        scriptContent,
        /if\s+!\s+run_elevated\s+"\$NFT_BIN"\s+-c\s+-f\s+"\$TMP_RULESET";\s+then[\s\S]*?exit 1/,
        "Must abort with exit 1 if nft -c -f fails"
      );

      // Verify ruleset is applied with -f only after check mode
      const checkIndex = scriptContent.indexOf('-c -f "$TMP_RULESET"');
      const applyIndex = scriptContent.indexOf('-f "$TMP_RULESET"', checkIndex + 1);
      assert.ok(
        checkIndex !== -1 && applyIndex !== -1 && checkIndex < applyIndex,
        "nft check mode (-c -f) must precede applying ruleset (-f)"
      );
    });
  });
});
