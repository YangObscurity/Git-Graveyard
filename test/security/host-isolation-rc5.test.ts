// Work package RC5: Second-round C-audit (N-C13/N-C15)
// Hardening of host-isolation.sh CIDR bounds, HTTPS-only manifest URL, safe su positional arg,
// and sha256 manifest parsing.

import * as assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/host-isolation.sh");

describe("Work package RC5: host-isolation.sh second-round C-audit fixes (N-C13, N-C15)", () => {
  const scriptContent = fs.readFileSync(SCRIPT_PATH, "utf-8");

  describe("N-C13: CIDR prefix bounds and base address rejection in is_valid_ipv4 and is_valid_ipv6", () => {
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

    it("rejects IPv4 prefixes /0 through /7 including 0.0.0.0/1, 128.0.0.0/1, and /7", () => {
      const rejectedIPv4 = [
        ["0", "0", "0", "0/1"].join("."),
        ["128", "0", "0", "0/1"].join("."),
        ["10", "0", "0", "0/7"].join("."),
        ["192", "168", "0", "0/0"].join("."),
        ["172", "16", "0", "0/6"].join("."),
      ];
      for (const ip of rejectedIPv4) {
        assert.equal(
          runBashValidation("is_valid_ipv4", ip),
          false,
          `Expected overly broad IPv4 CIDR to be rejected: ${ip}`
        );
      }
    });

    it("rejects IPv4 base 0.0.0.0 and 255.255.255.255", () => {
      const rejectedBases = [
        ["0", "0", "0", "0"].join("."),
        ["0", "0", "0", "0/8"].join("."),
        ["255", "255", "255", "255"].join("."),
        ["255", "255", "255", "255/32"].join("."),
      ];
      for (const ip of rejectedBases) {
        assert.equal(
          runBashValidation("is_valid_ipv4", ip),
          false,
          `Expected invalid base IPv4 address to be rejected: ${ip}`
        );
      }
    });

    it("accepts valid IPv4 with prefix between /8 and /32", () => {
      const acceptedIPv4 = [
        ["10", "0", "0", "0/8"].join("."),
        ["192", "168", "1", "1/32"].join("."),
        ["172", "16", "0", "0/12"].join("."),
        ["10", "1", "2", "0/24"].join("."),
        ["192", "168", "1", "1"].join("."),
      ];
      for (const ip of acceptedIPv4) {
        assert.equal(
          runBashValidation("is_valid_ipv4", ip),
          true,
          `Expected valid IPv4 CIDR to be accepted: ${ip}`
        );
      }
    });

    it("accepts IPv4 with leading-zero octets '08' and '09' without bash octal errors", () => {
      const leadingZeroIps = [
        ["192", "168", "08", "1"].join("."),
        ["192", "168", "09", "1"].join("."),
        ["10", "08", "09", "1/24"].join("."),
        ["172", "16", "08", "08/16"].join("."),
        ["8", "8", "08", "08"].join("."),
      ];
      for (const ip of leadingZeroIps) {
        assert.equal(
          runBashValidation("is_valid_ipv4", ip),
          true,
          `Expected IPv4 with leading zeros (08/09) to be accepted without octal error: ${ip}`
        );
      }

      // Values > 255 with leading zero must still be rejected without octal error
      assert.equal(
        runBashValidation("is_valid_ipv4", "192.168.08.256"),
        false,
        "Octet > 255 must be rejected"
      );
    });

    it("rejects IPv6 prefixes < 32 or > 128 including ::/1, ::/0, and all-zero base ::", () => {
      const rejectedIPv6 = [
        [":", ":", "/1"].join(""),
        [":", ":", "/0"].join(""),
        [":", ":"].join(""),
        ["0", ":", ":"].join(""),
        [":", ":", "0"].join(""),
        ["2001", "db8", "", "/31"].join(":"),
        ["2001", "db8", "", "/129"].join(":"),
        [":", ":", "/32"].join(""),
        [":", ":", "/128"].join(""),
      ];
      for (const ip of rejectedIPv6) {
        assert.equal(
          runBashValidation("is_valid_ipv6", ip),
          false,
          `Expected invalid IPv6 CIDR or all-zero base to be rejected: ${ip}`
        );
      }
    });

    it("accepts valid IPv6 with prefix between /32 and /128 and non-zero base", () => {
      const acceptedIPv6 = [
        ["2001", "db8", "", "/32"].join(":"),
        ["2001", "db8", "", "/64"].join(":"),
        ["2001", "db8", "", "/128"].join(":"),
        [":", ":", "1"].join(""),
        ["fe80", "", "1"].join(":"),
      ];
      for (const ip of acceptedIPv6) {
        assert.equal(
          runBashValidation("is_valid_ipv6", ip),
          true,
          `Expected valid IPv6 to be accepted: ${ip}`
        );
      }
    });
  });

  describe("N-C15: MANIFEST_URL HTTPS-only, safe su positional arg, strict sha256 manifest parsing", () => {
    function extractStep2UrlCheck(): string {
      const match = scriptContent.match(
        /manifest_content=""[\s\S]*?(?=normalized_expected=)/
      );
      assert.ok(match, "Step 2 manifest retrieval logic must be present");
      return match[0];
    }

    it("explicitly rejects http:// MANIFEST_URL with non-zero exit", () => {
      const step2 = extractStep2UrlCheck();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc5-http-"));
      try {
        const httpUrl = ["http:", "", "insecure.example.invalid", "manifest"].join("/");
        const bashCode = `
set -euo pipefail
MANIFEST_URL="${httpUrl}"
${step2}
`;
        const res = child_process.spawnSync("bash", ["-c", bashCode], {
          encoding: "utf-8",
        });
        assert.notEqual(res.status, 0, "http:// URL must be rejected with non-zero exit");
        assert.match(
          res.stderr,
          /insecure http:\/\/|http:\/\//i,
          "Error message should mention insecure http:// URL rejection"
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("accepts existing local file path or file:// URL for MANIFEST_URL", () => {
      const step2 = extractStep2UrlCheck();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc5-local-"));
      try {
        const manifestFile = path.join(tempDir, "manifest.txt");
        const dummySha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        fs.writeFileSync(manifestFile, `${dummySha}\n`, "utf-8");

        // Local path
        const bashCodeLocal = `
set -euo pipefail
MANIFEST_URL="${manifestFile}"
${step2}
echo -n "$manifest_content"
`;
        const resLocal = child_process.spawnSync("bash", ["-c", bashCodeLocal], {
          encoding: "utf-8",
        });
        assert.equal(resLocal.status, 0, `Local manifest path must succeed: ${resLocal.stderr}`);
        assert.ok(resLocal.stdout.includes(dummySha));

        // file:// URL
        const bashCodeFileUrl = `
set -euo pipefail
MANIFEST_URL="file://${manifestFile}"
${step2}
echo -n "$manifest_content"
`;
        const resFileUrl = child_process.spawnSync("bash", ["-c", bashCodeFileUrl], {
          encoding: "utf-8",
        });
        assert.equal(resFileUrl.status, 0, `file:// URL must succeed: ${resFileUrl.stderr}`);
        assert.ok(resFileUrl.stdout.includes(dummySha));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

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

    it("verifies sha256sum '<64-hex>  filename' format correctly", () => {
      const twoSpaces = `${sha64}  kiro-cli-3.1.0.tar.gz\n`;
      const resTwoSpaces = runChecksumVerification(sha64, twoSpaces);
      assert.equal(
        resTwoSpaces.status,
        0,
        `sha256sum with two spaces must be verified: ${resTwoSpaces.stderr}`
      );

      const oneSpace = `${sha64} kiro-cli-3.1.0.tar.gz\n`;
      const resOneSpace = runChecksumVerification(sha64, oneSpace);
      assert.equal(
        resOneSpace.status,
        0,
        `sha256sum with single space must be verified: ${resOneSpace.stderr}`
      );

      const bareSha = `${sha64}\n`;
      const resBare = runChecksumVerification(sha64, bareSha);
      assert.equal(
        resBare.status,
        0,
        `bare 64-hex sha must be verified: ${resBare.stderr}`
      );

      const upperSha = `${sha64.toUpperCase()}  kiro-cli-3.1.0.tar.gz\n`;
      const resUpper = runChecksumVerification(sha64, upperSha);
      assert.equal(
        resUpper.status,
        0,
        `uppercase sha in manifest must normalize and verify: ${resUpper.stderr}`
      );
    });

    it("rejects substring and non-first-field sha false positives", () => {
      const prefixSubstring = `prefix_${sha64}  kiro-cli-3.1.0.tar.gz\n`;
      const resPrefix = runChecksumVerification(sha64, prefixSubstring);
      assert.notEqual(resPrefix.status, 0, "Prefix substring must be rejected");

      const longerHex = `${sha64}aabb\n`;
      const resLonger = runChecksumVerification(sha64, longerHex);
      assert.notEqual(resLonger.status, 0, "Longer hex string must be rejected");

      const secondField = `kiro-cli-3.1.0.tar.gz  ${sha64}\n`;
      const resSecond = runChecksumVerification(sha64, secondField);
      assert.notEqual(resSecond.status, 0, "SHA in second field must be rejected");
    });

    it("su check safely passes NECRO_FILES_DIR as positional argument without shell injection", () => {
      // Statically verify the exact command pattern in Step 4
      assert.match(
        scriptContent,
        /su\s+-s\s+\/bin\/bash\s+"\$SKEL_USER"\s+-c\s+'test -r "\$1"'\s+--\s+"\$NECRO_FILES_DIR"/,
        "su command must use positional argument passing: su -s /bin/bash \"$SKEL_USER\" -c 'test -r \"$1\"' -- \"$NECRO_FILES_DIR\""
      );

      // Verify that malicious chars inside NECRO_FILES_DIR cannot cause shell injection
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc5-su-"));
      try {
        const injectionWitness = path.join(tempDir, "pwned.txt");
        const maliciousDir = `/tmp/test'$(touch ${injectionWitness})"; touch ${injectionWitness} #`;

        const bashCode = `
set -euo pipefail
SKEL_USER="$(id -un)"
NECRO_FILES_DIR='${maliciousDir.replace(/'/g, "'\\''")}'
bash -c 'test -r "$1"' -- "$NECRO_FILES_DIR" || true
`;
        child_process.spawnSync("bash", ["-c", bashCode], {
          encoding: "utf-8",
        });

        assert.equal(
          fs.existsSync(injectionWitness),
          false,
          "Shell injection payload must never be executed via argument expansion"
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("scripts/host-isolation.sh retains LF line endings with no CR characters", () => {
      const buf = fs.readFileSync(SCRIPT_PATH);
      assert.equal(buf.includes(0x0d), false, "Script must not contain CR (\\r) line endings");
      assert.ok(buf.includes(0x0a), "Script must contain LF (\\n) line endings");
    });
  });

  describe("Path C: Hostname resolution IPv4 validation and private/reserved range rejection", () => {
    function runHostnameResolution(hostname: string, mockResolvedIps: string[]) {
      const matchFunctions = scriptContent.match(
        /is_valid_ipv4\(\) \{[\s\S]*?is_valid_hostname\(\) \{[\s\S]*?\n\}/
      );
      assert.ok(matchFunctions, "Validation functions must be present in host-isolation.sh");

      const matchAllowlist = scriptContent.match(
        /allow_rules=""[\s\S]*?done < "\$ALLOWLIST_FILE"\s*\nfi/
      );
      assert.ok(matchAllowlist, "Allowlist processing loop must be present");

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc5-dns-"));
      try {
        const allowlistFile = path.join(tempDir, "allowlist.txt");
        fs.writeFileSync(allowlistFile, `${hostname}\n`, "utf-8");

        const getentLines = mockResolvedIps.map((ip) => `${ip} STREAM ${hostname}`).join("\n");
        const binDir = path.join(tempDir, "bin");
        fs.mkdirSync(binDir);
        const mockGetent = path.join(binDir, "getent");
        fs.writeFileSync(
          mockGetent,
          `#!/bin/bash\ncat <<'EOF'\n${getentLines}\nEOF\n`,
          { mode: 0o755 }
        );

        const bashCode = `
set -euo pipefail
export PATH="${binDir}:$PATH"
SKEL_UID=1001
ALLOWLIST_FILE="${allowlistFile}"
${matchFunctions[0]}
${matchAllowlist[0]}
echo -n "$allow_rules"
`;
        return child_process.spawnSync("bash", ["-c", bashCode], {
          encoding: "utf-8",
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    it("rejects loopback 127.* resolved IPs", () => {
      const res = runHostnameResolution("localhost.example.com", ["127.0.0.1"]);
      assert.notEqual(res.status, 0);
      assert.equal(res.stdout.includes("127.0.0.1"), false);
      assert.match(res.stderr, /failed to resolve to an IPv4 address/i);
    });

    it("rejects private 10.* resolved IPs", () => {
      const res = runHostnameResolution("internal.example.com", ["10.0.1.5"]);
      assert.notEqual(res.status, 0);
      assert.equal(res.stdout.includes("10.0.1.5"), false);
      assert.match(res.stderr, /failed to resolve to an IPv4 address/i);
    });

    it("rejects link-local 169.254.* resolved IPs", () => {
      const res = runHostnameResolution("metadata.example.com", ["169.254.169.254"]);
      assert.notEqual(res.status, 0);
      assert.equal(res.stdout.includes("169.254.169.254"), false);
      assert.match(res.stderr, /failed to resolve to an IPv4 address/i);
    });

    it("rejects private 192.168.* resolved IPs", () => {
      const res = runHostnameResolution("router.example.com", ["192.168.1.1"]);
      assert.notEqual(res.status, 0);
      assert.equal(res.stdout.includes("192.168.1.1"), false);
      assert.match(res.stderr, /failed to resolve to an IPv4 address/i);
    });

    it("rejects private 172.16-31.* resolved IPs", () => {
      for (const ip of ["172.16.0.1", "172.20.1.1", "172.31.255.254"]) {
        const res = runHostnameResolution("corp.example.com", [ip]);
        assert.notEqual(res.status, 0, `Expected rejection for private IP ${ip}`);
        assert.equal(res.stdout.includes(ip), false);
        assert.match(res.stderr, /failed to resolve to an IPv4 address/i);
      }
    });

    it("rejects CGNAT 100.64-127.* resolved IPs", () => {
      for (const ip of ["100.64.0.1", "100.100.5.5", "100.127.255.254"]) {
        const res = runHostnameResolution("cgnat.example.com", [ip]);
        assert.notEqual(res.status, 0, `Expected rejection for CGNAT IP ${ip}`);
        assert.equal(res.stdout.includes(ip), false);
        assert.match(res.stderr, /failed to resolve to an IPv4 address/i);
      }
    });

    it("rejects current network 0.* and multicast/reserved >=224.* resolved IPs", () => {
      for (const ip of ["0.0.0.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "254.0.0.1"]) {
        const res = runHostnameResolution("reserved.example.com", [ip]);
        assert.notEqual(res.status, 0, `Expected rejection for reserved IP ${ip}`);
        assert.equal(res.stdout.includes(ip), false);
        assert.match(res.stderr, /failed to resolve to an IPv4 address/i);
      }
    });

    it("accepts public IPv4 resolved addresses and creates accept rule", () => {
      const res = runHostnameResolution("api.example.com", ["93.184.216.34"]);
      assert.equal(res.status, 0, `Public IP should resolve successfully: ${res.stderr}`);
      assert.ok(
        res.stdout.includes("skuid 1001 ip daddr 93.184.216.34 accept"),
        "Accept rule must be present for public IP"
      );
    });

    it("filters out private IPs while retaining public IPs when hostname resolves to both", () => {
      const res = runHostnameResolution("mixed.example.com", ["127.0.0.1", "93.184.216.34", "10.0.0.1"]);
      assert.equal(res.status, 0, `Mixed IP should succeed if at least one public IP is present: ${res.stderr}`);
      assert.ok(res.stdout.includes("skuid 1001 ip daddr 93.184.216.34 accept"));
      assert.equal(res.stdout.includes("127.0.0.1"), false);
      assert.equal(res.stdout.includes("10.0.0.1"), false);
    });
  });
});
