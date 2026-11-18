import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redactText,
  redactValue,
  scanTextForSecrets,
} from "../../lib/security/redactor";

const opts = { autoRegisterEnvSecrets: false };

describe("redactor RB1: N-B13 expanded sensitive token patterns", () => {
  it("redacts Stripe live secret keys (sk_live_)", () => {
    const validKey = "sk_live_" + "1234567890abcdefghij"; // 20 chars after prefix
    const longerKey = "sk_live_" + "abcdefghijklmnopqrstuvwxyz123456";
    const shortKey = "sk_live_" + "1234567890abcdefghi"; // 19 chars: not a key

    for (const key of [validKey, longerKey]) {
      const text = `stripe key: ${key}`;
      const redacted = redactText(text, opts);
      assert.ok(!redacted.includes(key), `expected ${key} to be redacted`);
      assert.ok(redacted.includes("[REDACTED]"));

      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, true);
      assert.equal(scan.passed, false);
      assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));
    }

    const shortText = `stripe key: ${shortKey}`;
    assert.equal(redactText(shortText, opts), shortText);
    const shortScan = scanTextForSecrets(shortText, opts);
    assert.equal(shortScan.hasSecrets, false);
    assert.equal(shortScan.passed, true);
  });

  it("redacts Stripe live restricted keys (rk_live_)", () => {
    const validKey = "rk_live_" + "1234567890abcdefghij"; // 20 chars after prefix
    const longerKey = "rk_live_" + "abcdefghijklmnopqrstuvwxyz123456";
    const shortKey = "rk_live_" + "1234567890abcdefghi"; // 19 chars: not a key

    for (const key of [validKey, longerKey]) {
      const text = `stripe restricted: ${key}`;
      const redacted = redactText(text, opts);
      assert.ok(!redacted.includes(key), `expected ${key} to be redacted`);
      assert.ok(redacted.includes("[REDACTED]"));

      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, true);
      assert.equal(scan.passed, false);
      assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));
    }

    const shortText = `stripe restricted: ${shortKey}`;
    assert.equal(redactText(shortText, opts), shortText);
    const shortScan = scanTextForSecrets(shortText, opts);
    assert.equal(shortScan.hasSecrets, false);
    assert.equal(shortScan.passed, true);
  });

  it("redacts AWS temporary STS access keys starting with ASIA", () => {
    const validAsia1 = "ASIA1234567890SAMPLE";
    const validAsia2 = "ASIAIOSFODNN7EXAMPLE";
    const validAkia = "AKIA1234567890SAMPLE";
    const bareAsia = "ASIA";
    const shortAsia = "ASIAMORE"; // 4 chars after ASIA, not 16

    for (const key of [validAsia1, validAsia2, validAkia]) {
      const text = `aws token: ${key}`;
      const redacted = redactText(text, opts);
      assert.ok(!redacted.includes(key), `expected ${key} to be redacted`);
      assert.ok(redacted.includes("[REDACTED]"));

      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, true);
      assert.equal(scan.passed, false);
      assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));
    }

    for (const text of [`prefix: ${bareAsia}`, `word: ${shortAsia}`]) {
      assert.equal(redactText(text, opts), text);
      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, false);
      assert.equal(scan.passed, true);
    }
  });

  it("redacts Slack xoxe-, xoxe-1-, and xapp- tokens in addition to xox[aboprs]-", () => {
    const tokens = [
      "xoxe-1234567890", // exactly 10 after dash
      "xoxe-abcdefghijk",
      "xoxe-1-1234567890abcdef",
      "xapp-1234567890",
      "xapp-1-1234567890abcdef",
      "xoxo-1234567890abcdef",
      "xoxb-1234567890abcdef",
    ];

    for (const token of tokens) {
      const text = `slack token: ${token}`;
      const redacted = redactText(text, opts);
      assert.ok(!redacted.includes(token), `expected ${token} to be redacted`);
      assert.ok(redacted.includes("[REDACTED]"));

      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, true, `expected scan hit for ${token}`);
      assert.equal(scan.passed, false);
    }

    // Negative tests: fewer than 10 characters after prefix
    const shortTokens = [
      "xoxe-123456789", // 9 chars
      "xapp-123456789", // 9 chars
    ];
    for (const short of shortTokens) {
      const text = `slack token: ${short}`;
      assert.equal(redactText(text, opts), text);
      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, false);
      assert.equal(scan.passed, true);
    }
  });

  it("redacts npm tokens (npm_)", () => {
    const validNpm = "npm_" + "123456789012345678901234567890"; // 30 chars
    const longerNpm = "npm_" + "abcdefghijklmnopqrstuvwxyz1234567890";
    const shortNpm = "npm_" + "12345678901234567890123456789"; // 29 chars

    for (const token of [validNpm, longerNpm]) {
      const text = `npm access: ${token}`;
      const redacted = redactText(text, opts);
      assert.ok(!redacted.includes(token), `expected ${token} to be redacted`);
      assert.ok(redacted.includes("[REDACTED]"));

      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, true);
      assert.equal(scan.passed, false);
      assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));
    }

    const shortText = `npm access: ${shortNpm}`;
    assert.equal(redactText(shortText, opts), shortText);
    const shortScan = scanTextForSecrets(shortText, opts);
    assert.equal(shortScan.hasSecrets, false);
    assert.equal(shortScan.passed, true);
  });

  it("redacts GitLab Personal Access Tokens (glpat-)", () => {
    const validGlpat = "glpat-" + "12345678901234567890"; // 20 chars
    const longerGlpat = "glpat-" + "abcdefghijklmnopqrstuvwxyz123456";
    const shortGlpat = "glpat-" + "1234567890123456789"; // 19 chars

    for (const token of [validGlpat, longerGlpat]) {
      const text = `gitlab token: ${token}`;
      const redacted = redactText(text, opts);
      assert.ok(!redacted.includes(token), `expected ${token} to be redacted`);
      assert.ok(redacted.includes("[REDACTED]"));

      const scan = scanTextForSecrets(text, opts);
      assert.equal(scan.hasSecrets, true);
      assert.equal(scan.passed, false);
      assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));
    }

    const shortText = `gitlab token: ${shortGlpat}`;
    assert.equal(redactText(shortText, opts), shortText);
    const shortScan = scanTextForSecrets(shortText, opts);
    assert.equal(shortScan.hasSecrets, false);
    assert.equal(shortScan.passed, true);
  });

  it("redacts three-segment JWTs starting with eyJ", () => {
    const sampleJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    const text = `jwt auth token: ${sampleJwt}`;
    const redacted = redactText(text, opts);
    assert.ok(!redacted.includes(sampleJwt));
    assert.ok(redacted.includes("[REDACTED]"));

    const scan = scanTextForSecrets(text, opts);
    assert.equal(scan.hasSecrets, true);
    assert.equal(scan.passed, false);
    assert.ok(scan.violations.some((v) => v.type === "sensitive_pattern"));

    // Negative tests: two segments only or invalid second segment
    const twoSegment =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0";
    const notJwtPayload =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "payloadNotStartingWithEyJ12345." +
      "signature12345678";

    for (const nonJwt of [twoSegment, notJwtPayload]) {
      const nonJwtText = `data: ${nonJwt}`;
      assert.equal(redactText(nonJwtText, opts), nonJwtText);
      const nonJwtScan = scanTextForSecrets(nonJwtText, opts);
      assert.equal(nonJwtScan.hasSecrets, false);
      assert.equal(nonJwtScan.passed, true);
    }
  });
});

describe("redactor RB1: N-B14 shared DAG references and circular object graphs", () => {
  it("redacts shared DAG object references ({ a: shared, b: shared }) without unredacted secret leaks", () => {
    const secretValue = "sk_live_" + "abcdefghijklmnopqrstuv1234";
    const shared = {
      apiKey: secretValue,
      label: "shared-credential",
      metadata: { count: 1 },
    };

    const root = {
      a: shared,
      b: shared,
      name: "root-dag",
    };

    const redacted = redactValue(root, opts);

    // Both branches must be redacted
    assert.equal(redacted.a.apiKey, "[REDACTED]");
    assert.equal(redacted.b.apiKey, "[REDACTED]");
    assert.equal(redacted.a.label, "shared-credential");
    assert.equal(redacted.b.label, "shared-credential");

    // Memoized DAG reference must be shared between branches
    assert.equal(redacted.a, redacted.b);

    // Original unredacted object must NOT be returned or mutated
    assert.notEqual(redacted.a, shared);
    assert.equal(shared.apiKey, secretValue);

    // Verify zero secret leaks across entire serialized output
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes(secretValue));
    assert.ok(serialized.includes("[REDACTED]"));
  });

  it("handles deep DAG references with multiple shared subtrees across arrays and objects", () => {
    const secretNpm = "npm_" + "1234567890abcdef1234567890abcdef";
    const secretGlpat = "glpat-" + "1234567890abcdefghij";

    const leafNode = {
      token: secretNpm,
      scope: "internal",
    };

    const middleA = {
      pat: secretGlpat,
      leaf: leafNode,
    };

    const middleB = {
      pat: secretGlpat,
      leaf: leafNode,
    };

    const root = {
      left: middleA,
      right: middleB,
      items: [leafNode, middleA, leafNode],
    };

    const redacted = redactValue(root, opts);

    // Verify leaf memoization
    assert.equal(redacted.left.leaf.token, "[REDACTED]");
    assert.equal(redacted.right.leaf.token, "[REDACTED]");
    assert.equal(redacted.left.leaf, redacted.right.leaf);
    assert.equal(redacted.items[0], redacted.items[2]);
    assert.equal(redacted.items[0], redacted.left.leaf);
    assert.equal(redacted.items[1], redacted.left);

    // Verify middle branches
    assert.equal(redacted.left.pat, "[REDACTED]");
    assert.equal(redacted.right.pat, "[REDACTED]");

    // Verify zero leak in full structure
    const json = JSON.stringify(redacted);
    assert.ok(!json.includes(secretNpm));
    assert.ok(!json.includes(secretGlpat));
  });

  it("handles shared DAG references in Sets and Maps cleanly", () => {
    const secretAsia = "ASIA1234567890SAMPLE";
    const sharedData = {
      stsToken: secretAsia,
      region: "us-east-1",
    };

    const map = new Map<string, typeof sharedData>([
      ["primary", sharedData],
      ["secondary", sharedData],
    ]);

    const set = new Set<typeof sharedData>([sharedData]);

    const container = {
      map,
      set,
      ref: sharedData,
    };

    const redacted = redactValue(container, opts);

    const redactedPrimary = redacted.map.get("primary");
    const redactedSecondary = redacted.map.get("secondary");
    assert.ok(redactedPrimary !== undefined);
    assert.ok(redactedSecondary !== undefined);
    assert.equal(redactedPrimary.stsToken, "[REDACTED]");
    assert.equal(redactedSecondary.stsToken, "[REDACTED]");
    assert.equal(redactedPrimary, redactedSecondary);
    assert.equal(redactedPrimary, redacted.ref);

    const setItems = Array.from(redacted.set);
    assert.equal(setItems.length, 1);
    assert.equal(setItems[0].stsToken, "[REDACTED]");
    assert.equal(setItems[0], redacted.ref);
  });

  it("handles self-referencing circular objects with zero unredacted leaks", () => {
    const secretKey = "rk_live_" + "1234567890abcdefghij";
    const node: Record<string, unknown> = {
      name: "circular-root",
      secret: secretKey,
    };
    node.self = node;

    const redacted = redactValue(node, opts);

    assert.equal(redacted.name, "circular-root");
    assert.equal(redacted.secret, "[REDACTED]");

    // Self reference points to the redacted clone, NEVER the original
    assert.equal(redacted.self, redacted);
    assert.notEqual(redacted, node);
    assert.equal((redacted.self as typeof redacted).secret, "[REDACTED]");

    // Original node is intact and unmutated
    assert.equal(node.secret, secretKey);
  });

  it("handles mutually circular object graphs (A -> B -> A)", () => {
    const secretA = "sk_live_" + "1234567890abcdefghij";
    const secretB = "xoxe-1-1234567890abcdef";

    const nodeA: Record<string, unknown> = {
      name: "nodeA",
      tokenA: secretA,
    };
    const nodeB: Record<string, unknown> = {
      name: "nodeB",
      tokenB: secretB,
      parent: nodeA,
    };
    nodeA.child = nodeB;

    const redactedA = redactValue(nodeA, opts);

    assert.equal(redactedA.tokenA, "[REDACTED]");
    const redactedB = redactedA.child as Record<string, unknown>;
    assert.ok(redactedB !== undefined);
    assert.equal(redactedB.tokenB, "[REDACTED]");

    // Cycles point to the redacted clones
    assert.equal(redactedB.parent, redactedA);
    assert.notEqual(redactedA, nodeA);
    assert.notEqual(redactedB, nodeB);

    // Mutual cycle traversed multiple steps retains redaction
    assert.equal(((redactedA.child as any).parent as any).tokenA, "[REDACTED]");
    assert.equal(
      (((redactedA.child as any).parent as any).child as any).tokenB,
      "[REDACTED]"
    );
  });

  it("handles circular arrays and maps without infinite recursion or leaks", () => {
    const secretJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    // Circular array
    const circularArr: unknown[] = [{ jwt: secretJwt }];
    circularArr.push(circularArr);

    const redactedArr = redactValue(circularArr, opts);
    assert.equal((redactedArr[0] as { jwt: string }).jwt, "[REDACTED]");
    assert.equal(redactedArr[1], redactedArr);
    assert.notEqual(redactedArr, circularArr);

    // Circular map
    const circularMap = new Map<string, unknown>();
    circularMap.set("secret", secretJwt);
    circularMap.set("self", circularMap);

    const redactedMap = redactValue(circularMap, opts);
    assert.equal(redactedMap.get("secret"), "[REDACTED]");
    assert.equal(redactedMap.get("self"), redactedMap);
    assert.notEqual(redactedMap, circularMap);

    // Circular set
    const circularSet = new Set<unknown>();
    circularSet.add(circularSet);

    const redactedSet = redactValue(circularSet, opts);
    assert.equal(redactedSet.has(redactedSet), true);
    assert.notEqual(redactedSet, circularSet);
  });
});
