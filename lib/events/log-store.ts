import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEnvSecrets, redactText, SECRET_ENV_VARS } from "../security/redactor";

export { SECRET_ENV_VARS, getEnvSecrets };

export interface TailOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TailResult {
  tail: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

export interface StoreCommandOutputParams {
  logRef?: string;
  runId?: string;
  stdout?: string;
  stderr?: string;
  merged?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  oomKilled?: boolean;
  maxTailLines?: number;
  maxTailBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface StoredCommandResult {
  logRef: string;
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
  exitCode?: number | null;
  timedOut: boolean;
  oomKilled: boolean;
}

export interface StoredLog {
  logRef: string;
  runId?: string;
  createdAt: number;
  stdout?: string;
  stderr?: string;
  content: string;
  exitCode?: number | null;
  timedOut?: boolean;
  oomKilled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface LogSliceOptions {
  offset?: number;
  limit?: number;
  unit?: "lines" | "bytes";
}

export interface LogSliceResult {
  logRef: string;
  content: string;
  offset: number;
  limit: number;
  total: number;
  unit: "lines" | "bytes";
  hasMore: boolean;
}

export interface LogStoreOptions {
  dir?: string;
  inMemory?: boolean;
  redactor?: (text: string) => string;
  defaultMaxTailLines?: number;
  defaultMaxTailBytes?: number;
}

const DEFAULT_TAIL_LINES = 100;
const DEFAULT_TAIL_BYTES = 10 * 1024; // 10 KB

export function generateLogRef(runId?: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 10);
  if (runId && typeof runId === "string" && runId.length > 0) {
    const cleanRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `log-${cleanRunId}-${ts}-${rand}`;
  }
  return `log-${ts}-${rand}`;
}

function sanitizeLogRef(logRef: string): string {
  if (!logRef || typeof logRef !== "string") {
    throw new TypeError("logRef must be a non-empty string");
  }
  const clean = path.basename(logRef).replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (!clean || clean === "." || clean === "..") {
    throw new Error(`Invalid logRef: "${logRef}"`);
  }
  return clean;
}

export function extractTail(text: string, options?: TailOptions): TailResult {
  if (!text || typeof text !== "string") {
    return { tail: "", truncated: false, totalLines: 0, totalBytes: 0 };
  }

  const maxLines =
    typeof options?.maxLines === "number" && options.maxLines > 0
      ? options.maxLines
      : DEFAULT_TAIL_LINES;
  const maxBytes =
    typeof options?.maxBytes === "number" && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_TAIL_BYTES;

  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf8");

  let truncated = false;
  let selected = lines;

  if (lines.length > maxLines) {
    selected = lines.slice(-maxLines);
    truncated = true;
  }

  let tail = selected.join("\n");
  const tailBytes = Buffer.byteLength(tail, "utf8");

  if (tailBytes > maxBytes) {
    truncated = true;
    const buf = Buffer.from(tail, "utf8");
    const sliced = buf.subarray(buf.length - maxBytes);
    tail = sliced.toString("utf8");
  }

  return {
    tail,
    truncated,
    totalLines,
    totalBytes,
  };
}

function sliceContent(
  logRef: string,
  content: string,
  options?: LogSliceOptions
): LogSliceResult {
  const unit = options?.unit ?? "lines";
  const offset =
    typeof options?.offset === "number" && options.offset >= 0
      ? options.offset
      : 0;
  const limit =
    typeof options?.limit === "number" && options.limit > 0
      ? options.limit
      : 100;

  if (unit === "lines") {
    const lines = content.split("\n");
    const total = lines.length;
    const sliced = lines.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    return {
      logRef,
      content: sliced.join("\n"),
      offset,
      limit,
      total,
      unit: "lines",
      hasMore,
    };
  } else {
    const buf = Buffer.from(content, "utf8");
    const total = buf.length;
    const sliced = buf.subarray(offset, offset + limit);
    const hasMore = offset + limit < total;
    return {
      logRef,
      content: sliced.toString("utf8"),
      offset,
      limit,
      total,
      unit: "bytes",
      hasMore,
    };
  }
}

export class LogStore {
  readonly dir: string | null;
  readonly inMemory: boolean;
  readonly redactor: (text: string) => string;
  readonly defaultMaxTailLines: number;
  readonly defaultMaxTailBytes: number;

  private readonly memStore: Map<string, StoredLog>;
  private readonly registeredSecrets: Set<string>;

  constructor(options?: LogStoreOptions) {
    this.inMemory = !!options?.inMemory;
    this.memStore = new Map<string, StoredLog>();
    this.registeredSecrets = new Set<string>();

    const builtIn = (text: string): string => {
      const liveSecrets = new Set<string>(this.registeredSecrets);
      for (const s of getEnvSecrets()) {
        liveSecrets.add(s);
      }
      return redactText(text, {
        secrets: Array.from(liveSecrets),
      });
    };

    if (options?.redactor) {
      const custom = options.redactor;
      // Requirement: Built-in redactor always runs first, and an injected redactor can only add rules
      this.redactor = (text: string): string => {
        const floorRedacted = builtIn(text);
        const customRedacted = custom(floorRedacted);
        return builtIn(customRedacted);
      };
    } else {
      this.redactor = builtIn;
    }

    this.defaultMaxTailLines =
      options?.defaultMaxTailLines ?? DEFAULT_TAIL_LINES;
    this.defaultMaxTailBytes =
      options?.defaultMaxTailBytes ?? DEFAULT_TAIL_BYTES;

    if (!this.inMemory) {
      this.dir =
        options?.dir ?? path.resolve(process.cwd(), ".agent-ws/logs");
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
    } else {
      this.dir = null;
    }
  }

  registerSecret(secret: string): void {
    if (typeof secret === "string" && secret.trim().length > 0) {
      this.registeredSecrets.add(secret.trim());
    }
  }

  registerSecrets(secrets: Iterable<string>): void {
    for (const s of secrets) {
      this.registerSecret(s);
    }
  }

  getRegisteredSecrets(): string[] {
    return Array.from(this.registeredSecrets);
  }

  private getLogFilePath(cleanRef: string): string | null {
    if (!this.dir) return null;
    return path.join(this.dir, `${cleanRef}.log`);
  }

  private getJsonFilePath(cleanRef: string): string | null {
    if (!this.dir) return null;
    return path.join(this.dir, `${cleanRef}.json`);
  }

  storeCommandOutput(params: StoreCommandOutputParams): StoredCommandResult {
    if (!params || typeof params !== "object") {
      throw new TypeError("params must be an object");
    }

    const logRef = params.logRef ?? generateLogRef(params.runId);
    const cleanRef = sanitizeLogRef(logRef);

    const rawStdout = params.stdout ?? "";
    const rawStderr = params.stderr ?? "";

    // Requirement 32.11: raw command output is redacted before storage
    const redactedStdout = this.redactor(rawStdout);
    const redactedStderr = this.redactor(rawStderr);

    let fullContent = "";
    if (params.merged !== undefined) {
      fullContent = this.redactor(params.merged);
    } else if (redactedStdout && redactedStderr) {
      fullContent = `${redactedStdout}\n${redactedStderr}`;
    } else {
      fullContent = redactedStdout || redactedStderr;
    }

    const maxTailLines = params.maxTailLines ?? this.defaultMaxTailLines;
    const maxTailBytes = params.maxTailBytes ?? this.defaultMaxTailBytes;

    const stdoutTailRes = extractTail(redactedStdout, {
      maxLines: maxTailLines,
      maxBytes: maxTailBytes,
    });
    const stderrTailRes = extractTail(redactedStderr, {
      maxLines: maxTailLines,
      maxBytes: maxTailBytes,
    });

    const truncated =
      stdoutTailRes.truncated || stderrTailRes.truncated;

    const record: StoredLog = {
      logRef,
      runId: params.runId,
      createdAt: Date.now(),
      stdout: redactedStdout,
      stderr: redactedStderr,
      content: fullContent,
      exitCode: params.exitCode,
      timedOut: !!params.timedOut,
      oomKilled: !!params.oomKilled,
      metadata: params.metadata,
    };

    this.memStore.set(cleanRef, record);

    if (this.dir) {
      try {
        const logPath = this.getLogFilePath(cleanRef);
        const jsonPath = this.getJsonFilePath(cleanRef);
        if (logPath) {
          fs.writeFileSync(logPath, fullContent, "utf8");
        }
        if (jsonPath) {
          fs.writeFileSync(jsonPath, JSON.stringify(record), "utf8");
        }
      } catch (err) {
        // Disk persistence error handling
        if (!this.inMemory) {
          throw err;
        }
      }
    }

    return {
      logRef,
      stdoutTail: stdoutTailRes.tail,
      stderrTail: stderrTailRes.tail,
      truncated,
      exitCode: params.exitCode,
      timedOut: !!params.timedOut,
      oomKilled: !!params.oomKilled,
    };
  }

  writeLog(
    logRef: string,
    content: string | Buffer,
    metadata?: Record<string, unknown>
  ): string {
    const cleanRef = sanitizeLogRef(logRef);
    const rawStr = typeof content === "string" ? content : content.toString("utf8");

    // Redact raw log content before storing
    const redacted = this.redactor(rawStr);

    const record: StoredLog = {
      logRef,
      createdAt: Date.now(),
      content: redacted,
      metadata,
    };

    this.memStore.set(cleanRef, record);

    if (this.dir) {
      const logPath = this.getLogFilePath(cleanRef);
      const jsonPath = this.getJsonFilePath(cleanRef);
      if (logPath) {
        fs.writeFileSync(logPath, redacted, "utf8");
      }
      if (jsonPath && metadata) {
        fs.writeFileSync(jsonPath, JSON.stringify(record), "utf8");
      }
    }

    return logRef;
  }

  getLog(logRef: string): string | null {
    if (!logRef || typeof logRef !== "string") {
      return null;
    }
    const cleanRef = sanitizeLogRef(logRef);

    const inMem = this.memStore.get(cleanRef);
    if (inMem) {
      return inMem.content;
    }

    if (this.dir) {
      const logPath = this.getLogFilePath(cleanRef);
      if (logPath && fs.existsSync(logPath)) {
        try {
          return fs.readFileSync(logPath, "utf8");
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  getLogRecord(logRef: string): StoredLog | null {
    if (!logRef || typeof logRef !== "string") {
      return null;
    }
    const cleanRef = sanitizeLogRef(logRef);

    const inMem = this.memStore.get(cleanRef);
    if (inMem) {
      return inMem;
    }

    if (this.dir) {
      const jsonPath = this.getJsonFilePath(cleanRef);
      if (jsonPath && fs.existsSync(jsonPath)) {
        try {
          const raw = fs.readFileSync(jsonPath, "utf8");
          const parsed = JSON.parse(raw) as StoredLog;
          this.memStore.set(cleanRef, parsed);
          return parsed;
        } catch {
          // fall through to text log
        }
      }

      const logPath = this.getLogFilePath(cleanRef);
      if (logPath && fs.existsSync(logPath)) {
        try {
          const content = fs.readFileSync(logPath, "utf8");
          const record: StoredLog = {
            logRef,
            createdAt: Date.now(),
            content,
          };
          this.memStore.set(cleanRef, record);
          return record;
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  getLogSlice(logRef: string, options?: LogSliceOptions): LogSliceResult {
    const content = this.getLog(logRef) ?? "";
    return sliceContent(logRef, content, options);
  }

  hasLog(logRef: string): boolean {
    if (!logRef || typeof logRef !== "string") {
      return false;
    }
    try {
      const cleanRef = sanitizeLogRef(logRef);
      if (this.memStore.has(cleanRef)) {
        return true;
      }
      if (this.dir) {
        const logPath = this.getLogFilePath(cleanRef);
        return !!logPath && fs.existsSync(logPath);
      }
    } catch {
      return false;
    }
    return false;
  }

  deleteLog(logRef: string): boolean {
    if (!logRef || typeof logRef !== "string") {
      return false;
    }
    try {
      const cleanRef = sanitizeLogRef(logRef);
      let removed = this.memStore.delete(cleanRef);

      if (this.dir) {
        const logPath = this.getLogFilePath(cleanRef);
        const jsonPath = this.getJsonFilePath(cleanRef);
        if (logPath && fs.existsSync(logPath)) {
          fs.unlinkSync(logPath);
          removed = true;
        }
        if (jsonPath && fs.existsSync(jsonPath)) {
          fs.unlinkSync(jsonPath);
          removed = true;
        }
      }

      return removed;
    } catch {
      return false;
    }
  }

  listLogs(): string[] {
    const refs = new Set<string>();
    for (const [key, record] of this.memStore.entries()) {
      refs.add(record.logRef || key);
    }

    if (this.dir && fs.existsSync(this.dir)) {
      try {
        const files = fs.readdirSync(this.dir);
        for (const file of files) {
          if (file.endsWith(".log")) {
            const base = file.slice(0, -4);
            refs.add(base);
          }
        }
      } catch {
        // directory read error ignored
      }
    }

    return Array.from(refs);
  }

  clear(): void {
    this.memStore.clear();
    if (this.dir && fs.existsSync(this.dir)) {
      try {
        const files = fs.readdirSync(this.dir);
        for (const file of files) {
          if (file.endsWith(".log") || file.endsWith(".json")) {
            fs.unlinkSync(path.join(this.dir, file));
          }
        }
      } catch {
        // directory clear error ignored
      }
    }
  }
}

export function createLogStore(options?: LogStoreOptions): LogStore {
  return new LogStore(options);
}

let defaultLogStoreInstance: LogStore | null = null;

export function getDefaultLogStore(options?: LogStoreOptions): LogStore {
  const g = globalThis as unknown as { __sharedLogStore?: LogStore };
  if (g.__sharedLogStore) {
    return g.__sharedLogStore;
  }
  const inMemory = Boolean(options?.inMemory);
  const resolvedDir = inMemory
    ? undefined
    : (options?.dir ??
       process.env.LOG_STORE_DIR ??
       path.join(os.tmpdir(), "git-graveyard-data", "logs"));

  const store = new LogStore({
    ...options,
    dir: resolvedDir,
    inMemory,
  });
  g.__sharedLogStore = store;
  defaultLogStoreInstance = store;
  return store;
}

export function resetDefaultLogStore(): void {
  const g = globalThis as unknown as { __sharedLogStore?: LogStore };
  const store = g.__sharedLogStore ?? defaultLogStoreInstance;
  if (store) {
    try {
      if (typeof (store as any).close === "function") {
        (store as any).close();
      }
    } catch {
      // ignore
    }
    g.__sharedLogStore = undefined;
    defaultLogStoreInstance = null;
  }
}
