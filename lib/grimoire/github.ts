import { buildGithubUrl } from "./normalize";

export type GitHubErrorCode =
  | "REPO_EMPTY"
  | "REPO_NOT_FOUND"
  | "RATE_LIMITED"
  | "GITHUB_UNAVAILABLE";

export interface RepoMetadata {
  full_name: string;
  default_branch: string;
  created_at: string;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  fullName?: string;
  defaultBranch?: string;
  createdAt?: string;
  stargazersCount?: number;
  forksCount?: number;
  stars?: number;
}

export interface DefaultHeadCommit {
  sha: string;
  message: string;
  lastCommitAt: string;
  commitMessage?: string;
  lastCommitMessage?: string;
  committerDate?: string;
  lastWords?: string;
}

export interface RepoEmptyError {
  ok: false;
  code: "REPO_EMPTY";
  message?: string;
  full_name?: string;
  fullName?: string;
}

export interface RepoNotFoundError {
  ok: false;
  code: "REPO_NOT_FOUND";
  message?: string;
  full_name?: string;
  fullName?: string;
}

export interface RateLimitedError {
  ok: false;
  code: "RATE_LIMITED";
  resetAt?: number;
  resetTime?: string;
  reset?: number | string;
  message?: string;
  full_name?: string;
  fullName?: string;
}

export interface GitHubUnavailableError {
  ok: false;
  code: "GITHUB_UNAVAILABLE";
  message?: string;
  full_name?: string;
  fullName?: string;
}

export type GitHubFetchError =
  | RepoEmptyError
  | RepoNotFoundError
  | RateLimitedError
  | GitHubUnavailableError;

export type FetchRepoMetadataSuccess = {
  ok: true;
  full_name: string;
  default_branch: string;
  created_at: string;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  data?: RepoMetadata;
  fullName?: string;
  defaultBranch?: string;
  createdAt?: string;
  stargazersCount?: number;
  forksCount?: number;
  stars?: number;
};

export type FetchDefaultHeadSuccess = {
  ok: true;
  sha: string;
  message: string;
  lastCommitAt: string;
  data?: DefaultHeadCommit;
  commitMessage?: string;
  lastCommitMessage?: string;
  committerDate?: string;
  lastWords?: string;
};

export type FetchRepoMetadataResult =
  | FetchRepoMetadataSuccess
  | GitHubFetchError;

export type FetchDefaultHeadResult =
  | FetchDefaultHeadSuccess
  | GitHubFetchError;

export type FetchImpl =
  | typeof fetch
  | ((input: any, init?: any) => Promise<Response>);

function getAuthHeaders(): Record<string, string> {
  const token =
    typeof process !== "undefined" && process.env
      ? process.env.GITHUB_TOKEN
      : undefined;
  if (token && typeof token === "string" && token.trim().length > 0) {
    return {
      Authorization: `Bearer ${token.trim()}`,
    };
  }
  return {};
}

function buildHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Git-Graveyard",
    ...getAuthHeaders(),
  };
}

function getHeader(response: Response, name: string): string | null {
  if (!response || !response.headers) {
    return null;
  }
  if (typeof response.headers.get === "function") {
    return response.headers.get(name);
  }
  const headersObj = response.headers as unknown as Record<string, string>;
  return headersObj[name] ?? headersObj[name.toLowerCase()] ?? null;
}

function getResetAt(response: Response): {
  resetAt?: number;
  resetTime?: string;
} {
  const raw = getHeader(response, "x-ratelimit-reset");
  if (!raw) {
    return {};
  }
  const parsed = parseInt(raw, 10);
  return {
    resetAt: Number.isFinite(parsed) ? parsed : undefined,
    resetTime: raw,
  };
}

function isRateLimited(response: Response, body: any): boolean {
  if (response.status === 429) {
    return true;
  }
  if (response.status === 403) {
    const remaining = getHeader(response, "x-ratelimit-remaining");
    if (remaining === "0") {
      return true;
    }
    const msg =
      typeof body?.message === "string" ? body.message.toLowerCase() : "";
    if (msg.includes("rate limit")) {
      return true;
    }
  }
  return false;
}

function isRepoEmpty(response: Response, body: any): boolean {
  if (response.status === 409 || response.status === 422) {
    return true;
  }
  const msg =
    typeof body?.message === "string" ? body.message.toLowerCase() : "";
  if (
    msg.includes("repository is empty") ||
    msg.includes("git repository is empty")
  ) {
    return true;
  }
  return false;
}

async function parseJsonSafely(response: Response): Promise<any> {
  try {
    if (typeof response.json === "function") {
      return await response.json();
    }
    if (typeof response.text === "function") {
      const text = await response.text();
      return JSON.parse(text);
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchImpl
): Promise<
  | { kind: "response"; response: Response }
  | { kind: "unavailable" }
> {
  let res1: Response | undefined;
  let fail1 = false;
  try {
    res1 = await fetchFn(url, { method: "GET", headers });
    if (res1 && res1.status >= 500 && res1.status <= 599) {
      fail1 = true;
    }
  } catch {
    fail1 = true;
  }

  if (!fail1 && res1) {
    return { kind: "response", response: res1 };
  }

  let res2: Response | undefined;
  let fail2 = false;
  try {
    res2 = await fetchFn(url, { method: "GET", headers });
    if (res2 && res2.status >= 500 && res2.status <= 599) {
      fail2 = true;
    }
  } catch {
    fail2 = true;
  }

  if (fail2 || !res2) {
    return { kind: "unavailable" };
  }

  return { kind: "response", response: res2 };
}

function createRepoEmptyError(owner?: string, repo?: string): RepoEmptyError {
  const fullName = owner && repo ? `${owner}/${repo}` : undefined;
  const res: RepoEmptyError = {
    ok: false,
    code: "REPO_EMPTY",
    message: "The repository default branch contains no commits.",
  };
  if (fullName) {
    Object.defineProperties(res, {
      full_name: { value: fullName, enumerable: false, configurable: true },
      fullName: { value: fullName, enumerable: false, configurable: true },
    });
  }
  return res;
}

function createRepoNotFoundError(
  owner?: string,
  repo?: string
): RepoNotFoundError {
  const fullName = owner && repo ? `${owner}/${repo}` : undefined;
  const res: RepoNotFoundError = {
    ok: false,
    code: "REPO_NOT_FOUND",
    message: "The repository was not found or is private.",
  };
  if (fullName) {
    Object.defineProperties(res, {
      full_name: { value: fullName, enumerable: false, configurable: true },
      fullName: { value: fullName, enumerable: false, configurable: true },
    });
  }
  return res;
}

function createRateLimitedError(
  resetAt?: number,
  resetTime?: string,
  owner?: string,
  repo?: string
): RateLimitedError {
  const fullName = owner && repo ? `${owner}/${repo}` : undefined;
  const res: RateLimitedError = {
    ok: false,
    code: "RATE_LIMITED",
    resetAt,
    resetTime: resetTime ?? (resetAt !== undefined ? String(resetAt) : undefined),
    message: "The GitHub API rate limit was exceeded.",
  };
  Object.defineProperties(res, {
    reset: {
      get() {
        return this.resetAt ?? this.resetTime;
      },
      enumerable: false,
      configurable: true,
    },
  });
  if (fullName) {
    Object.defineProperties(res, {
      full_name: { value: fullName, enumerable: false, configurable: true },
      fullName: { value: fullName, enumerable: false, configurable: true },
    });
  }
  return res;
}

function createGitHubUnavailableError(
  owner?: string,
  repo?: string
): GitHubUnavailableError {
  const fullName = owner && repo ? `${owner}/${repo}` : undefined;
  return {
    ok: false,
    code: "GITHUB_UNAVAILABLE",
    message: "GitHub services are temporarily unavailable.",
    full_name: fullName,
    fullName: fullName,
  };
}

function createRepoMetadataSuccess(
  owner: string,
  repo: string,
  raw: any
): FetchRepoMetadataSuccess {
  const full_name = String(raw.full_name ?? `${owner}/${repo}`);
  const default_branch = String(raw.default_branch ?? "");
  const created_at = String(raw.created_at ?? "");
  const archived = Boolean(raw.archived);
  const stargazers_count =
    typeof raw.stargazers_count === "number"
      ? raw.stargazers_count
      : Number(raw.stargazers_count ?? 0);
  const forks_count =
    typeof raw.forks_count === "number"
      ? raw.forks_count
      : Number(raw.forks_count ?? 0);

  const res: FetchRepoMetadataSuccess = {
    ok: true,
    full_name,
    default_branch,
    created_at,
    archived,
    stargazers_count,
    forks_count,
  };

  Object.defineProperties(res, {
    data: {
      get() {
        return this;
      },
      enumerable: false,
      configurable: true,
    },
    fullName: {
      get() {
        return this.full_name;
      },
      enumerable: false,
      configurable: true,
    },
    defaultBranch: {
      get() {
        return this.default_branch;
      },
      enumerable: false,
      configurable: true,
    },
    createdAt: {
      get() {
        return this.created_at;
      },
      enumerable: false,
      configurable: true,
    },
    stargazersCount: {
      get() {
        return this.stargazers_count;
      },
      enumerable: false,
      configurable: true,
    },
    forksCount: {
      get() {
        return this.forks_count;
      },
      enumerable: false,
      configurable: true,
    },
    stars: {
      get() {
        return this.stargazers_count;
      },
      enumerable: false,
      configurable: true,
    },
  });

  return res;
}

function createDefaultHeadSuccess(
  sha: string,
  message: string,
  lastCommitAt: string
): FetchDefaultHeadSuccess {
  const res: FetchDefaultHeadSuccess = {
    ok: true,
    sha,
    message,
    lastCommitAt,
  };

  Object.defineProperties(res, {
    data: {
      get() {
        return this;
      },
      enumerable: false,
      configurable: true,
    },
    commitMessage: {
      get() {
        return this.message;
      },
      enumerable: false,
      configurable: true,
    },
    lastCommitMessage: {
      get() {
        return this.message;
      },
      enumerable: false,
      configurable: true,
    },
    committerDate: {
      get() {
        return this.lastCommitAt;
      },
      enumerable: false,
      configurable: true,
    },
    lastWords: {
      get() {
        const lines = this.message
          .split("\n")
          .map((l: string) => l.trim())
          .filter(Boolean);
        return lines[0]?.slice(0, 120) ?? "";
      },
      enumerable: false,
      configurable: true,
    },
  });

  return res;
}

export async function fetchRepoMetadata(
  owner: string,
  repo: string,
  fetchImpl?: FetchImpl
): Promise<FetchRepoMetadataResult> {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("No fetch implementation available");
  }

  let url: string;
  try {
    url = buildGithubUrl("api", owner, repo);
  } catch {
    return createRepoNotFoundError(owner, repo);
  }

  const headers = buildHeaders();
  const execResult = await fetchWithRetry(url, headers, fetchFn);

  if (execResult.kind === "unavailable") {
    return createGitHubUnavailableError(owner, repo);
  }

  const { response } = execResult;
  const body = await parseJsonSafely(response);

  if (isRateLimited(response, body)) {
    const { resetAt, resetTime } = getResetAt(response);
    return createRateLimitedError(resetAt, resetTime, owner, repo);
  }

  if (response.status === 404) {
    if (isRepoEmpty(response, body)) {
      return createRepoEmptyError(owner, repo);
    }
    return createRepoNotFoundError(owner, repo);
  }

  if (response.status === 409 || response.status === 422) {
    return createRepoEmptyError(owner, repo);
  }

  if (response.status < 200 || response.status >= 300) {
    return createRepoNotFoundError(owner, repo);
  }

  if (!body || typeof body !== "object") {
    return createGitHubUnavailableError(owner, repo);
  }

  return createRepoMetadataSuccess(owner, repo, body);
}

export async function fetchDefaultHead(
  owner: string,
  repo: string,
  defaultBranch: string,
  fetchImpl?: FetchImpl
): Promise<FetchDefaultHeadResult> {
  if (
    !defaultBranch ||
    typeof defaultBranch !== "string" ||
    defaultBranch.trim().length === 0
  ) {
    return createRepoEmptyError(owner, repo);
  }

  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("No fetch implementation available");
  }

  let url: string;
  try {
    url = buildGithubUrl("api", owner, repo, defaultBranch);
  } catch {
    try {
      const baseUrl = buildGithubUrl("api", owner, repo);
      url = `${baseUrl}/commits/${defaultBranch}`;
    } catch {
      return createRepoNotFoundError(owner, repo);
    }
  }

  const headers = buildHeaders();
  const execResult = await fetchWithRetry(url, headers, fetchFn);

  if (execResult.kind === "unavailable") {
    return createGitHubUnavailableError(owner, repo);
  }

  const { response } = execResult;
  const body = await parseJsonSafely(response);

  if (isRateLimited(response, body)) {
    const { resetAt, resetTime } = getResetAt(response);
    return createRateLimitedError(resetAt, resetTime, owner, repo);
  }

  if (isRepoEmpty(response, body)) {
    return createRepoEmptyError(owner, repo);
  }

  if (response.status === 404) {
    return createRepoNotFoundError(owner, repo);
  }

  if (response.status < 200 || response.status >= 300) {
    return createRepoNotFoundError(owner, repo);
  }

  const commitObj = Array.isArray(body) ? body[0] : body;
  if (!commitObj || typeof commitObj !== "object" || !commitObj.sha) {
    return createRepoEmptyError(owner, repo);
  }

  const sha = String(commitObj.sha);
  const message = String(commitObj.commit?.message ?? "");
  const lastCommitAt = String(
    commitObj.commit?.committer?.date ??
      commitObj.commit?.author?.date ??
      ""
  );

  return createDefaultHeadSuccess(sha, message, lastCommitAt);
}
