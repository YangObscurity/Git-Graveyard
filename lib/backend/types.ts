// Task 7.1 / Requirement 43.1
export type BackendKind = "instabox-docker" | "docker-cloud-sandbox";

// Task 7.1
export interface ExecutionBackend {
  readonly kind?: BackendKind;
  create(spec: SandboxSpec): Promise<Sandbox>;
  get?(id: string): Promise<Sandbox | undefined>;
  list?(labels?: Record<string, string>): AsyncIterable<unknown> | Promise<unknown[]>;
  destroy?(id: string): Promise<void>;
}

// Task 7.1
export interface Sandbox {
  readonly id: string;
  exec(req: ExecRequest): Promise<ExecProcess>;
  run(req: ExecRequest): Promise<ExecResult>;
  wait(): Promise<{ exitCode: number | null; signal?: string; timedOut?: boolean; oomKilled?: boolean }>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

// Task 7.1 / Requirement 43.7
export interface SandboxUser {
  uid: number;
  gid?: number;
  home?: string;
}

// Task 7.1 / Requirement 21 / Requirement 43
export interface SandboxSpec {
  idempotencyKey: string;
  user?: SandboxUser;
  uid?: number;
  userId?: number;
  env?: Record<string, string>;
  secrets?: unknown;
  ports?: unknown;
  command?: unknown;
  argv?: string[];
  labels?: Record<string, string>;
  image?: string;
  resources?: {
    cpus?: number;
    memoryMiB?: number;
    pids?: number;
    diskMiB?: number;
    noNewPrivileges?: boolean;
    readOnlyRoot?: boolean;
  };
  lifetime?: {
    ttlMs?: number;
    onTimeout?: "stop" | "delete";
  };
  workspace?:
    | { mode: "bind"; hostPath: string; mountAt: string; readOnly?: boolean }
    | { mode: "sync"; mountAt: string; seedFrom?: string };
  network?: {
    default: "deny";
    allow?: Array<{ host: string; ports?: number[]; reason?: string }>;
  };
  [key: string]: unknown;
}

// Task 7.1 / Requirement 43.2
export interface ExecRequest {
  argv: string[];
  idempotencyKey?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  tag?: string;
  command?: unknown;
  cmd?: unknown;
  [key: string]: unknown;
}

// Requirement 43.6
export interface ExecChunk {
  seq: number;
  data?: unknown; // type not fixed by spec
  stream?: "stdout" | "stderr" | "merged";
  at?: number;
}

// Task 7.1
export interface ExecProcess {
  seq?: number;
  output?: AsyncIterable<ExecChunk>;
  signal?(sig: "SIGINT" | "SIGTERM" | "SIGKILL" | string): Promise<void>;
  wait(): Promise<{ exitCode: number | null; signal?: string; timedOut?: boolean; oomKilled?: boolean }>;
}

// Task 7.1
export interface ExecResult {
  logRef: string;
  oomKilled: boolean;
  timedOut: boolean;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
  truncated?: boolean;
}

export interface HardenedExecResult extends ExecResult {
  logRef: string;
  oomKilled: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  truncated?: boolean;
}
