import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  redactText,
  scanTextForSecrets,
  scanWorktreeFiles,
  SENSITIVE_PATTERNS,
} from "../../lib/security/redactor";

describe("lib/security/redactor-r3: M-9 SENSITIVE_PATTERNS narrowing and credentials", () => {
  it("does not flag ordinary public certificates in scanTextForSecrets or redactText", () => {
    const publicCert = [
      "-----BEGIN CERTIFICATE-----",
      "MIIDXTCCAkWgAwIBAgIJAL0psk1234567890ABCDEFGH==",
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Y",
      "-----END CERTIFICATE-----",
    ].join("\n");

    const scan = scanTextForSecrets(publicCert, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, true, "Public certificate must not fail secret scan");
    assert.equal(scan.hasSecrets, false);
    assert.equal(scan.violations.length, 0);

    const redacted = redactText(publicCert, { autoRegisterEnvSecrets: false });
    assert.equal(redacted, publicCert, "Public certificate should not be redacted");
  });

  it("does not flag test fixtures named cert or cert files in scanWorktreeFiles", () => {
    const certFixtureContent = "export const cert = 'sample test cert content';\nconst certPath = './fixtures/cert.pem';";
    const files = [
      { path: "test/fixtures/cert.pem", content: certFixtureContent },
      { path: "src/crypto/cert-verifier.ts", content: "export function verifyCert(cert: string) { return true; }" },
    ];

    const scan = scanWorktreeFiles(files, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, true, "Test fixture named cert must not be flagged");
    assert.equal(scan.hasSecrets, false);
    assert.equal(scan.violations.length, 0);
  });

  it("does not flag single-line or unclosed certificate header", () => {
    const singleLineCertHeader = "-----BEGIN CERTIFICATE-----";
    const scan = scanTextForSecrets(singleLineCertHeader, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, true);
    assert.equal(scan.hasSecrets, false);

    const redacted = redactText(`Header: ${singleLineCertHeader}`, { autoRegisterEnvSecrets: false });
    assert.equal(redacted, `Header: ${singleLineCertHeader}`);
  });

  it("flags and redacts full PEM private key blocks", () => {
    const privateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Yxyz1234567890abcdef...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const scan = scanTextForSecrets(privateKey, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, false, "Private key must be flagged");
    assert.equal(scan.hasSecrets, true);
    assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));

    const redacted = redactText(privateKey, { autoRegisterEnvSecrets: false });
    assert.ok(!redacted.includes("RSA PRIVATE KEY"));
    assert.ok(redacted.includes("[REDACTED]"));
  });

  it("flags and redacts unclosed or single-line private key headers", () => {
    const privHeader = "-----BEGIN PRIVATE KEY-----";
    const scan = scanTextForSecrets(privHeader, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, false, "Single-line private key header must be flagged");
    assert.equal(scan.hasSecrets, true);

    const redacted = redactText(`Found: ${privHeader}`, { autoRegisterEnvSecrets: false });
    assert.equal(redacted, "Found: [REDACTED]");
  });

  it("flags and redacts known token prefixes ghp_, gho_, ghu_, ghs_, ghr_ and github_pat_", () => {
    const tokens = [
      "ghp_ClassicToken1234567890",
      "gho_OAuthToken1234567890",
      "ghu_UserToServer1234567890",
      "ghs_ServerToServer1234567890",
      "ghr_RefreshToken1234567890",
      "github_pat_FineGrained1234567890",
    ];

    for (const token of tokens) {
      const scan = scanTextForSecrets(`token: ${token}`, { autoRegisterEnvSecrets: false });
      assert.equal(scan.passed, false, `Expected ${token} to be flagged`);
      assert.equal(scan.hasSecrets, true);

      const redacted = redactText(`Bearer ${token}`, { autoRegisterEnvSecrets: false });
      assert.ok(!redacted.includes(token), `Expected ${token} to be redacted`);
      assert.ok(redacted.includes("[REDACTED]"));
    }
  });

  it("flags generic API keys of twenty or more characters", () => {
    const longKey20 = "1234567890123456789a";
    const longKey32 = "abcdefghijklmnopqrstuvwxyz123456";

    const jsonInput = `{"apiKey": "${longKey20}"}`;
    const scanJson = scanTextForSecrets(jsonInput, { autoRegisterEnvSecrets: false });
    assert.equal(scanJson.passed, false, "20-char API key must be flagged");
    assert.equal(scanJson.hasSecrets, true);

    const redactedJson = redactText(jsonInput, { autoRegisterEnvSecrets: false });
    assert.ok(!redactedJson.includes(longKey20));
    assert.ok(redactedJson.includes("[REDACTED]"));

    const assignmentInput = `api_key = "${longKey32}"`;
    const scanAssign = scanTextForSecrets(assignmentInput, { autoRegisterEnvSecrets: false });
    assert.equal(scanAssign.passed, false, "32-char API key must be flagged");
    assert.equal(scanAssign.hasSecrets, true);

    const redactedAssign = redactText(assignmentInput, { autoRegisterEnvSecrets: false });
    assert.ok(!redactedAssign.includes(longKey32));
    assert.ok(redactedAssign.includes("[REDACTED]"));
  });

  it("does not flag generic API keys of fewer than twenty characters", () => {
    const shortKey19 = "123456789012345678a"; // 19 chars
    const shortKey5 = "abcde";

    const input1 = `apiKey: "${shortKey19}"`;
    const scan1 = scanTextForSecrets(input1, { autoRegisterEnvSecrets: false });
    assert.equal(scan1.passed, true, "19-character key should not trigger generic 20+ key pattern");
    assert.equal(scan1.hasSecrets, false);

    const input2 = `api_key = "${shortKey5}"`;
    const scan2 = scanTextForSecrets(input2, { autoRegisterEnvSecrets: false });
    assert.equal(scan2.passed, true);
    assert.equal(scan2.hasSecrets, false);
  });
});
