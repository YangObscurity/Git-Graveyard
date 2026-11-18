import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRepoInput, buildGithubUrl } from "../../lib/grimoire/normalize";

describe("normalize: parseRepoInput", () => {
  describe("URL forms and permutations (Requirement 1.1, 1.2)", () => {
    it("parses standard HTTPS URL", () => {
      const result = parseRepoInput("https://github.com/expressjs/express");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("parses HTTP URL", () => {
      const result = parseRepoInput("http://github.com/expressjs/express");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("parses scheme-less URL", () => {
      const result = parseRepoInput("github.com/expressjs/express");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("parses protocol-relative URL", () => {
      const result = parseRepoInput("//github.com/expressjs/express");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("handles leading and trailing whitespace", () => {
      const result = parseRepoInput("   https://github.com/expressjs/express   ");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("handles trailing slashes", () => {
      const result = parseRepoInput("https://github.com/expressjs/express/");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });

      const multiSlash = parseRepoInput("https://github.com/expressjs/express///");
      assert.deepEqual(multiSlash, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("strips .git suffix", () => {
      const result = parseRepoInput("https://github.com/expressjs/express.git");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });

      const withSlash = parseRepoInput("https://github.com/expressjs/express.git/");
      assert.deepEqual(withSlash, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("strips query parameters", () => {
      const result = parseRepoInput("https://github.com/expressjs/express?tab=readme-ov-file");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("strips URL fragment/hash", () => {
      const result = parseRepoInput("https://github.com/expressjs/express#readme");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("strips query and fragment together", () => {
      const result = parseRepoInput("https://github.com/expressjs/express?foo=bar#section");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("parses git SSH form (Requirement 1.2)", () => {
      const result = parseRepoInput("git@github.com:expressjs/express");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("parses git SSH form with .git suffix", () => {
      const result = parseRepoInput("git@github.com:expressjs/express.git");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });

    it("supports valid slug characters in owner and repo", () => {
      const result = parseRepoInput("https://github.com/alpha-beta_1.0/repo_name.test-2");
      assert.deepEqual(result, {
        ok: true,
        owner: "alpha-beta_1.0",
        repo: "repo_name.test-2",
        usesTreeRef: false,
      });
    });

    it("parses blob URL without setting usesTreeRef", () => {
      const result = parseRepoInput("https://github.com/expressjs/express/blob/main/README.md");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: false,
      });
    });
  });

  describe("Default-branch ref notice (Requirement 1.3, 1.4)", () => {
    it("flags tree ref when URL points to a tree branch", () => {
      const result = parseRepoInput("https://github.com/expressjs/express/tree/master");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: true,
      });
    });

    it("flags tree ref when URL points to a tree tag or subpath", () => {
      const result = parseRepoInput("https://github.com/expressjs/express/tree/v4.18.2");
      assert.deepEqual(result, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: true,
      });

      const nested = parseRepoInput("https://github.com/expressjs/express/tree/feature/new-api");
      assert.deepEqual(nested, {
        ok: true,
        owner: "expressjs",
        repo: "express",
        usesTreeRef: true,
      });
    });

    it("does not flag tree ref for standard repo URLs", () => {
      const result = parseRepoInput("https://github.com/expressjs/express");
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.usesTreeRef, false);
      }
    });
  });

  describe("Host, userinfo, port, and invalid slug rejection (Requirement 1.5, 1.6)", () => {
    it("rejects non-github.com hosts", () => {
      assert.deepEqual(parseRepoInput("https://gitlab.com/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://bitbucket.org/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://notgithub.com/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("git@gitlab.com:expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
    });

    it("rejects URLs containing ports", () => {
      assert.deepEqual(parseRepoInput("https://github.com:8080/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com:443/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("github.com:22/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
    });

    it("rejects URLs containing userinfo", () => {
      assert.deepEqual(parseRepoInput("https://user:pass@github.com/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://token@github.com/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
    });

    it("rejects disallowed protocols", () => {
      assert.deepEqual(parseRepoInput("ftp://github.com/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("ssh://github.com/expressjs/express"), {
        ok: false,
        code: "BAD_URL",
      });
    });

    it("rejects dot and double-dot as owner or repo (Requirement 1.6)", () => {
      assert.deepEqual(parseRepoInput("https://github.com/./express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/../express"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/expressjs/."), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/expressjs/.."), {
        ok: false,
        code: "BAD_URL",
      });
    });

    it("rejects invalid characters outside [A-Za-z0-9_.-]", () => {
      assert.deepEqual(parseRepoInput("https://github.com/owner name/repo"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/owner/repo$"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/owner!/repo"), {
        ok: false,
        code: "BAD_URL",
      });
    });

    it("rejects malformed inputs and incomplete paths", () => {
      assert.deepEqual(parseRepoInput(""), { ok: false, code: "BAD_URL" });
      assert.deepEqual(parseRepoInput("   "), { ok: false, code: "BAD_URL" });
      assert.deepEqual(parseRepoInput("https://github.com"), { ok: false, code: "BAD_URL" });
      assert.deepEqual(parseRepoInput("https://github.com/"), { ok: false, code: "BAD_URL" });
      assert.deepEqual(parseRepoInput("https://github.com/owner"), { ok: false, code: "BAD_URL" });
      assert.deepEqual(parseRepoInput("https://github.com/owner/"), { ok: false, code: "BAD_URL" });
      assert.deepEqual(parseRepoInput("https://github.com/owner/repo/tree"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/owner/repo/tree/"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/owner/repo/blob"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/owner/repo/issues"), {
        ok: false,
        code: "BAD_URL",
      });
      assert.deepEqual(parseRepoInput("https://github.com/owner/repo/pull/1"), {
        ok: false,
        code: "BAD_URL",
      });
    });
  });

  describe("Outbound URL limits (Requirement 1.7)", () => {
    it("builds github api urls", () => {
      assert.equal(
        buildGithubUrl("api", "owner", "repo"),
        "https://api.github.com/repos/owner/repo"
      );
      assert.equal(
        buildGithubUrl("api", "owner", "repo", "0123456789abcdef"),
        "https://api.github.com/repos/owner/repo/commits/0123456789abcdef"
      );
    });

    it("builds codeload tarball urls", () => {
      assert.equal(
        buildGithubUrl("codeload", "owner", "repo"),
        "https://codeload.github.com/owner/repo/tar.gz"
      );
      assert.equal(
        buildGithubUrl("codeload", "owner", "repo", "main"),
        "https://codeload.github.com/owner/repo/tar.gz/main"
      );
    });

    it("builds npm registry urls", () => {
      assert.equal(
        buildGithubUrl("registry", "owner", "repo"),
        "https://registry.npmjs.org/@owner/repo"
      );
      assert.equal(
        buildGithubUrl("registry", "owner", "repo", "1.0.0"),
        "https://registry.npmjs.org/@owner/repo/1.0.0"
      );
    });

    it("throws error for invalid owner or repo in buildGithubUrl", () => {
      assert.throws(() => buildGithubUrl("api", "bad/owner", "repo"), {
        message: /Invalid owner or repo/,
      });
      assert.throws(() => buildGithubUrl("api", "owner", ".."), {
        message: /Invalid owner or repo/,
      });
      assert.throws(() => buildGithubUrl("codeload", ".", "repo"), {
        message: /Invalid owner or repo/,
      });
    });

    it("throws error for invalid sha in buildGithubUrl", () => {
      assert.throws(() => buildGithubUrl("api", "owner", "repo", ""), {
        message: /Invalid sha/,
      });
      assert.throws(() => buildGithubUrl("api", "owner", "repo", "bad sha with spaces"), {
        message: /Invalid sha/,
      });
      assert.throws(() => buildGithubUrl("codeload", "owner", "repo", "../traversal"), {
        message: /Invalid sha/,
      });
    });

    it("throws error for unsupported kind", () => {
      assert.throws(() => buildGithubUrl("unknown" as any, "owner", "repo"), {
        message: /Unsupported kind/,
      });
    });
  });
});
