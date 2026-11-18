export type RepoParseResult =
  | { ok: true; owner: string; repo: string; usesTreeRef: boolean }
  | { ok: false; code: "BAD_URL" };

export type OutboundUrlKind = "api" | "codeload" | "registry";

function isValidSlug(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) {
    return false;
  }
  if (name === "." || name === "..") {
    return false;
  }
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

export function parseRepoInput(input: string): RepoParseResult {
  if (typeof input !== "string") {
    return { ok: false, code: "BAD_URL" };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, code: "BAD_URL" };
  }

  let s = trimmed;
  const hashIndex = s.indexOf("#");
  const queryIndex = s.indexOf("?");
  let cutIndex = -1;
  if (hashIndex !== -1 && queryIndex !== -1) {
    cutIndex = Math.min(hashIndex, queryIndex);
  } else if (hashIndex !== -1) {
    cutIndex = hashIndex;
  } else if (queryIndex !== -1) {
    cutIndex = queryIndex;
  }
  if (cutIndex !== -1) {
    s = s.slice(0, cutIndex);
  }

  let rawPath: string;

  if (s.startsWith("git@")) {
    if (!s.startsWith("git@github.com:")) {
      return { ok: false, code: "BAD_URL" };
    }
    rawPath = s.slice("git@github.com:".length);
  } else {
    if (s.startsWith("https://")) {
      s = s.slice("https://".length);
    } else if (s.startsWith("http://")) {
      s = s.slice("http://".length);
    } else if (s.includes("://")) {
      return { ok: false, code: "BAD_URL" };
    } else if (s.startsWith("//")) {
      s = s.slice(2);
    }

    const firstSlash = s.indexOf("/");
    if (firstSlash === -1) {
      return { ok: false, code: "BAD_URL" };
    }

    const host = s.slice(0, firstSlash);
    if (host !== "github.com") {
      return { ok: false, code: "BAD_URL" };
    }

    rawPath = s.slice(firstSlash + 1);
  }

  const path = rawPath.replace(/\/+$/, "");
  const segments = path.split("/");

  if (segments.length < 2) {
    return { ok: false, code: "BAD_URL" };
  }

  const owner = segments[0];
  let repo = segments[1];

  if (repo.endsWith(".git")) {
    repo = repo.slice(0, -4);
  }

  let usesTreeRef = false;

  if (segments.length > 2) {
    const sub = segments[2];
    if (sub === "tree") {
      if (segments.length < 4 || segments[3].length === 0) {
        return { ok: false, code: "BAD_URL" };
      }
      usesTreeRef = true;
    } else if (sub === "blob") {
      if (segments.length < 4 || segments[3].length === 0) {
        return { ok: false, code: "BAD_URL" };
      }
      usesTreeRef = false;
    } else {
      return { ok: false, code: "BAD_URL" };
    }
  }

  if (!isValidSlug(owner) || !isValidSlug(repo)) {
    return { ok: false, code: "BAD_URL" };
  }

  return {
    ok: true,
    owner,
    repo,
    usesTreeRef,
  };
}

export function buildGithubUrl(
  kind: "api" | "codeload" | "registry",
  owner: string,
  repo: string,
  sha?: string
): string {
  if (!isValidSlug(owner) || !isValidSlug(repo)) {
    throw new Error(`Invalid owner or repo: ${owner}/${repo}`);
  }
  if (sha !== undefined && (!sha || !isValidSlug(sha))) {
    throw new Error(`Invalid sha: ${sha}`);
  }

  switch (kind) {
    case "api":
      return sha
        ? `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`
        : `https://api.github.com/repos/${owner}/${repo}`;
    case "codeload":
      return sha
        ? `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`
        : `https://codeload.github.com/${owner}/${repo}/tar.gz`;
    case "registry":
      return sha
        ? `https://registry.npmjs.org/@${owner}/${repo}/${sha}`
        : `https://registry.npmjs.org/@${owner}/${repo}`;
    default: {
      const exhaustiveCheck: never = kind;
      throw new Error(`Unsupported kind: ${exhaustiveCheck}`);
    }
  }
}
