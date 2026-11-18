import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  redactText,
  scanTextForSecrets,
  scanWorktreeFiles,
  SENSITIVE_PATTERNS,
} from "../../lib/security/redactor";

describe("lib/security/redactor-r6b2: M-9 real body and generic key narrowing", () => {
  it("a bare ghp_ prefix and a bare AKIA are not matched", () => {
    // 1. Bare ghp_ prefix alone
    const scanGhp1 = scanTextForSecrets("ghp_", { autoRegisterEnvSecrets: false });
    assert.equal(scanGhp1.passed, true, "Bare ghp_ alone must not be flagged");
    assert.equal(scanGhp1.hasSecrets, false);
    assert.equal(scanGhp1.violations.length, 0);

    const scanGhp2 = scanTextForSecrets("const prefix = 'ghp_';", { autoRegisterEnvSecrets: false });
    assert.equal(scanGhp2.passed, true, "Bare ghp_ in assignment must not be flagged");
    assert.equal(scanGhp2.hasSecrets, false);

    const redactedGhp = redactText("prefix: ghp_", { autoRegisterEnvSecrets: false });
    assert.equal(redactedGhp, "prefix: ghp_", "Bare ghp_ must not be redacted");

    // Short ghp_ token with fewer than 20 chars
    const scanShortGhp = scanTextForSecrets("ghp_short12345", { autoRegisterEnvSecrets: false });
    assert.equal(scanShortGhp.passed, true, "Short ghp_ token under 20 chars must not be flagged");
    assert.equal(scanShortGhp.hasSecrets, false);

    // 2. Bare AKIA prefix alone
    const scanAkia1 = scanTextForSecrets("AKIA", { autoRegisterEnvSecrets: false });
    assert.equal(scanAkia1.passed, true, "Bare AKIA alone must not be flagged");
    assert.equal(scanAkia1.hasSecrets, false);
    assert.equal(scanAkia1.violations.length, 0);

    const scanAkia2 = scanTextForSecrets("id: AKIA", { autoRegisterEnvSecrets: false });
    assert.equal(scanAkia2.passed, true, "Bare AKIA in text must not be flagged");
    assert.equal(scanAkia2.hasSecrets, false);

    const redactedAkia = redactText("AWS prefix is AKIA", { autoRegisterEnvSecrets: false });
    assert.equal(redactedAkia, "AWS prefix is AKIA", "Bare AKIA must not be redacted");

    // Word starting with AKIA that does not have 16 uppercase/digit chars
    const scanAkiaWord1 = scanTextForSecrets("AKIAMORE", { autoRegisterEnvSecrets: false });
    assert.equal(scanAkiaWord1.passed, true, "AKIAMORE must not match AKIA pattern");
    assert.equal(scanAkiaWord1.hasSecrets, false);

    const scanAkiaWord2 = scanTextForSecrets("AKIABAR", { autoRegisterEnvSecrets: false });
    assert.equal(scanAkiaWord2.passed, true, "AKIABAR must not match AKIA pattern");
    assert.equal(scanAkiaWord2.hasSecrets, false);

    const redactedAkiaWords = redactText("Words: AKIAMORE and AKIABAR", { autoRegisterEnvSecrets: false });
    assert.equal(redactedAkiaWords, "Words: AKIAMORE and AKIABAR");
  });

  it("AKIA followed by exactly 16 uppercase or digit characters is matched", () => {
    // Standard AWS Access Key ID: AKIA + 16 chars from [A-Z0-9]
    const validAkia1 = "AKIAIOSFODNN7EXAMPLE";
    const validAkia2 = "AKIA1234567890SAMPLE";

    const scan1 = scanTextForSecrets(`AWS_ACCESS_KEY_ID=${validAkia1}`, { autoRegisterEnvSecrets: false });
    assert.equal(scan1.passed, false, "AKIA with 16 uppercase/digit chars must be flagged");
    assert.equal(scan1.hasSecrets, true);
    assert.equal(scan1.violations.length, 1);
    assert.equal(scan1.violations[0].type, "sensitive_pattern");
    assert.equal(scan1.violations[0].match, validAkia1);

    const scan2 = scanTextForSecrets(`key = "${validAkia2}"`, { autoRegisterEnvSecrets: false });
    assert.equal(scan2.passed, false);
    assert.equal(scan2.hasSecrets, true);
    assert.equal(scan2.violations[0].match, validAkia2);

    const redacted1 = redactText(`Found credentials: ${validAkia1}`, { autoRegisterEnvSecrets: false });
    assert.ok(!redacted1.includes(validAkia1));
    assert.equal(redacted1, "Found credentials: [REDACTED]");

    const redacted2 = redactText(`export AWS_KEY=${validAkia2}`, { autoRegisterEnvSecrets: false });
    assert.ok(!redacted2.includes(validAkia2));
    assert.equal(redacted2, "export AWS_KEY=[REDACTED]");

    // Verify in scanWorktreeFiles
    const worktreeScan = scanWorktreeFiles(
      [{ path: "config/aws.env", content: `AWS_ACCESS_KEY_ID=${validAkia1}\n` }],
      { autoRegisterEnvSecrets: false }
    );
    assert.equal(worktreeScan.passed, false);
    assert.equal(worktreeScan.hasSecrets, true);
    assert.deepEqual(worktreeScan.flaggedFiles, ["config/aws.env"]);
  });

  it("a 36-character ghp_ body is matched", () => {
    // GitHub classic PAT: ghp_ + 36 characters
    const body36 = "1234567890abcdef1234567890abcdef1234";
    assert.equal(body36.length, 36);
    const token = `ghp_${body36}`;

    const scan = scanTextForSecrets(`token: ${token}`, { autoRegisterEnvSecrets: false });
    assert.equal(scan.passed, false, "ghp_ token with 36-char body must be flagged");
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.violations.length, 1);
    assert.equal(scan.violations[0].match, token);

    const redacted = redactText(`Authorization: Bearer ${token}`, { autoRegisterEnvSecrets: false });
    assert.ok(!redacted.includes(token));
    assert.equal(redacted, "Authorization: Bearer [REDACTED]");

    // Boundary rule check: _ghp_ and xghp_ still match with 36-char body
    const prefixed1 = `prefix_${token}`;
    const prefixed2 = `x${token}`;
    assert.equal(redactText(prefixed1, { autoRegisterEnvSecrets: false }), "prefix_[REDACTED]");
    assert.equal(redactText(prefixed2, { autoRegisterEnvSecrets: false }), "x[REDACTED]");
  });

  it("an api_key assignment with a 32-character value that mixes letters and digits is matched", () => {
    // 32-character alphanumeric value containing both letters and digits
    const mixed32 = "abcdefghijklmnopqrstuvwxyz123456";
    assert.equal(mixed32.length, 32);

    // Assignment format 1: api_key = "..."
    const inputAssign = `api_key = "${mixed32}"`;
    const scanAssign = scanTextForSecrets(inputAssign, { autoRegisterEnvSecrets: false });
    assert.equal(scanAssign.passed, false, "api_key assignment with 32-char mixed value must be flagged");
    assert.equal(scanAssign.hasSecrets, true);
    assert.equal(scanAssign.violations.length, 1);
    assert.equal(scanAssign.violations[0].match, mixed32);

    const redactedAssign = redactText(inputAssign, { autoRegisterEnvSecrets: false });
    assert.ok(!redactedAssign.includes(mixed32));
    assert.equal(redactedAssign, 'api_key = "[REDACTED]"');

    // Assignment format 2: {"apiKey": "..."} (JSON)
    const inputJson = `{"apiKey": "${mixed32}"}`;
    const scanJson = scanTextForSecrets(inputJson, { autoRegisterEnvSecrets: false });
    assert.equal(scanJson.passed, false);
    assert.equal(scanJson.hasSecrets, true);
    assert.equal(scanJson.violations[0].match, mixed32);

    const redactedJson = redactText(inputJson, { autoRegisterEnvSecrets: false });
    assert.ok(!redactedJson.includes(mixed32));
    assert.equal(redactedJson, '{"apiKey": "[REDACTED]"}');

    // Assignment format 3: apiKey: '...' (single quotes)
    const inputSingle = `apiKey: '${mixed32}'`;
    const scanSingle = scanTextForSecrets(inputSingle, { autoRegisterEnvSecrets: false });
    assert.equal(scanSingle.passed, false);
    assert.equal(scanSingle.hasSecrets, true);

    const redactedSingle = redactText(inputSingle, { autoRegisterEnvSecrets: false });
    assert.ok(!redactedSingle.includes(mixed32));
    assert.equal(redactedSingle, "apiKey: '[REDACTED]'");
  });

  it("a camelCase identifier after apiKey is not matched", () => {
    // Code in dependencies / node_modules: identifier assignment
    const codeAssign = "const apiKey = camelCaseIdentifier;";
    const scanAssign = scanTextForSecrets(codeAssign, { autoRegisterEnvSecrets: false });
    assert.equal(scanAssign.passed, true, "camelCase identifier in const assignment must not match");
    assert.equal(scanAssign.hasSecrets, false);
    assert.equal(scanAssign.violations.length, 0);

    const redactedAssign = redactText(codeAssign, { autoRegisterEnvSecrets: false });
    assert.equal(redactedAssign, codeAssign, "camelCase identifier must not be redacted");

    // Object property assignment with identifier
    const codeObj = "const config = { apiKey: camelCaseIdentifier };";
    const scanObj = scanTextForSecrets(codeObj, { autoRegisterEnvSecrets: false });
    assert.equal(scanObj.passed, true, "camelCase identifier in object property must not match");
    assert.equal(scanObj.hasSecrets, false);

    const redactedObj = redactText(codeObj, { autoRegisterEnvSecrets: false });
    assert.equal(redactedObj, codeObj);

    // Long camelCase identifier (> 20 chars)
    const longIdentifier = "mySuperLongCamelCaseIdentifierVariable";
    const codeLong = `const apiKey = ${longIdentifier};`;
    const scanLong = scanTextForSecrets(codeLong, { autoRegisterEnvSecrets: false });
    assert.equal(scanLong.passed, true, "Long camelCase identifier must not match");
    assert.equal(scanLong.hasSecrets, false);

    const redactedLong = redactText(codeLong, { autoRegisterEnvSecrets: false });
    assert.equal(redactedLong, codeLong);

    // Plain English words in quotes (only letters, no digits)
    const plainWord = "supercalifragilisticexpialidocious";
    const codePlain = `apiKey = "${plainWord}"`;
    const scanPlain = scanTextForSecrets(codePlain, { autoRegisterEnvSecrets: false });
    assert.equal(scanPlain.passed, true, "Plain word without digits must not match");
    assert.equal(scanPlain.hasSecrets, false);

    const redactedPlain = redactText(codePlain, { autoRegisterEnvSecrets: false });
    assert.equal(redactedPlain, codePlain);

    // All digits in quotes (only digits, no letters)
    const allDigits = "123456789012345678901234567890";
    const codeDigits = `apiKey = "${allDigits}"`;
    const scanDigits = scanTextForSecrets(codeDigits, { autoRegisterEnvSecrets: false });
    assert.equal(scanDigits.passed, true, "All-digit literal without letters must not match");
    assert.equal(scanDigits.hasSecrets, false);

    // Compound identifier name like api_key_middleware_handler
    const compoundId = "api_key_configuration_options_default";
    const scanCompound = scanTextForSecrets(compoundId, { autoRegisterEnvSecrets: false });
    assert.equal(scanCompound.passed, true, "Compound identifier must not match");
    assert.equal(scanCompound.hasSecrets, false);
  });
});
