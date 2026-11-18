// Work package SB5: redaction pattern precision (audit items N-B4, M-9)
// Ordinary prose that merely mentions token-like fragments is not redacted;
// real-shaped sk-, AIza, xox and Bearer tokens are still redacted.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactText, scanTextForSecrets } from "../../lib/security/redactor";

const opts = { autoRegisterEnvSecrets: false };

describe("redactor SB5: no false positives on ordinary text", () => {
  it("does not redact the prose fragment xoxo", () => {
    const input = "the crowd cheered xoxo at the show";
    assert.equal(redactText(input, opts), input);
    const scan = scanTextForSecrets(input, opts);
    assert.equal(scan.hasSecrets, false);
    assert.equal(scan.passed, true);
  });

  it("does not redact the css class .sk-circle", () => {
    const input = "apply the class .sk-circle to the svg element";
    assert.equal(redactText(input, opts), input);
    const scan = scanTextForSecrets(input, opts);
    assert.equal(scan.hasSecrets, false);
    assert.equal(scan.passed, true);
  });

  it("does not redact the prose phrase Bearer token", () => {
    const input = "send the Bearer token in the authorization header";
    assert.equal(redactText(input, opts), input);
    const scan = scanTextForSecrets(input, opts);
    assert.equal(scan.hasSecrets, false);
    assert.equal(scan.passed, true);
  });

  it("redacts lowercase bearer followed by a real-shaped token", () => {
    // The Bearer scheme is case-insensitive (RFC 7235): lowercase "bearer" then 20+ token characters is redacted
    const input = "authorization: bearer eyJhbGciOiJIUzI1NiJ9.test.sig";
    assert.equal(redactText(input, opts), "authorization: bearer [REDACTED]");
  });
});

describe("redactor SB5: real-shaped tokens are still redacted", () => {
  it("redacts sk- tokens carrying at least 20 token characters after the prefix", () => {
    const boundary = "sk-abcdefghijklmnopqrst"; // exactly 20 after the prefix
    const longer = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const short = "sk-abcdefghijklmnopqrs"; // 19 after the prefix: not a key

    for (const token of [boundary, longer]) {
      const res = redactText(`key ${token} end`, opts);
      assert.ok(!res.includes(token), `expected redaction of ${token}`);
      assert.ok(res.includes("[REDACTED]"));
    }
    assert.equal(redactText(`key ${short} end`, opts), `key ${short} end`);
  });

  it("redacts AIza keys carrying exactly 35 characters after the prefix", () => {
    const valid = "AIzaSyDUMMYKEY1234567890ABCDEFGHIJKLMNO"; // 35 after the prefix
    assert.equal(valid.length, 39);
    const tooShort = "AIzaSyDUMMYKEY1234567890ABCDEFGHIJKLMN"; // 34 after the prefix

    const res = redactText(`key ${valid} end`, opts);
    assert.ok(!res.includes(valid), "expected redaction of the 35-character key");
    assert.ok(res.includes("[REDACTED]"));
    assert.equal(redactText(`key ${tooShort} end`, opts), `key ${tooShort} end`);
  });

  it("redacts xox tokens with one of abprs, a dash, then at least 10 characters", () => {
    const tokens = [
      "xoxb-1234567890", // exactly 10 after the dash
      "xoxp-9876543210abcdef",
      "xoxr-abcdefghijk",
      "xoxs-1234567890abcdef",
    ];
    for (const token of tokens) {
      const res = redactText(`slack ${token} end`, opts);
      assert.ok(!res.includes(token), `expected redaction of ${token}`);
      assert.ok(res.includes("[REDACTED]"));
    }
    // 9 characters after the dash: not a Slack token
    assert.equal(redactText("slack xoxb-123456789 end", opts), "slack xoxb-123456789 end");
  });

  it("redacts case-sensitive Bearer values carrying at least 20 token characters", () => {
    const res = redactText("Authorization: Bearer abcdefghijklmnopqrst", opts); // exactly 20
    assert.equal(res, "Authorization: Bearer [REDACTED]");

    const resLong = redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.signature", opts);
    assert.equal(resLong, "Authorization: Bearer [REDACTED]");

    // 19 token characters: prose length, not a token
    assert.equal(
      redactText("Authorization: Bearer abcdefghijklmnopqrs", opts),
      "Authorization: Bearer abcdefghijklmnopqrs"
    );
  });

  it("scanTextForSecrets flags real-shaped tokens and passes the prose fragments", () => {
    for (const text of [
      "key sk-abcdefghijklmnopqrst end",
      "key AIzaSyDUMMYKEY1234567890ABCDEFGHIJKLMNO end",
      "slack xoxb-1234567890 end",
      "Authorization: Bearer abcdefghijklmnopqrst",
    ]) {
      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, true, `expected flag: ${text}`);
      assert.equal(scan.passed, false, `expected flag: ${text}`);
    }
    for (const text of [
      "the crowd cheered xoxo at the show",
      "apply the class .sk-circle to the svg element",
      "send the Bearer token in the authorization header",
    ]) {
      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, false, `expected pass: ${text}`);
      assert.equal(scan.passed, true, `expected pass: ${text}`);
    }
  });
});
