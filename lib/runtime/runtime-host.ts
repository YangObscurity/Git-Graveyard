import * as http from "node:http";
import { EventEmitter } from "node:events";
import {
  EventEnvelope,
  EventInput,
  EventStore,
  getDefaultEventStore,
} from "../events/event-store";
import {
  getDefaultLogStore,
  LogStore,
} from "../events/log-store";
import {
  getDefaultRunStore,
  reconcileOnBoot,
  ReconcileResult,
  RunStore,
} from "../runs/run-store";
import {
  CollaborationStore,
} from "../gateway/collaboration-tools";
import {
  createExecutionBackend,
} from "../backend/execution-backend";
import type {
  ExecutionBackend,
  BackendKind,
} from "../backend/types";
import {
  ConnectProxy,
  ConnectProxyOptions,
} from "../backend/connect-proxy";
import {
  createMcpGatewayServer,
  FatalEventPayload,
  McpGateway,
  McpGatewayOptions,
} from "../gateway/mcp-gateway";
import {
  SkeletonSupervisor,
} from "../supervisor/skeleton-supervisor";
import type {
  SkeletonSupervisorEvent,
  SkeletonSupervisorOptions,
} from "../supervisor/types";
import { redactEvent } from "../security/redactor";

export type { FatalEventPayload };

export interface BackendAvailabilityAdapter {
  isAvailable: () => boolean;
  isHealthy: () => boolean;
  isPaused: () => boolean;
  getReason: () => string;
  backend: ExecutionBackend;
}

export interface AdmissionAvailabilityAdapter {
  isPaused: () => boolean;
  isUnavailable: () => boolean;
  isHealthy: () => boolean;
  getReason: () => string;
  getQueueLength: () => number;
  queue: unknown[];
}

export interface RuntimeHostOptions {
  runStore?: RunStore;
  eventStore?: EventStore;
  logStore?: LogStore;
  collaborationStore?: CollaborationStore;
  backend?: ExecutionBackend;
  backendKind?: BackendKind | string;
  connectProxyOptions?: ConnectProxyOptions;
  skipReconcile?: boolean;
  defaultTimeoutMs?: number;
  approvalWaitMs?: number;
  gatewayOptions?: Partial<McpGatewayOptions>;
  gateway?: McpGateway;
  onEvent?: (event: EventEnvelope) => void | Promise<void>;
  closeStoresOnShutdown?: boolean;
}

export interface GatewayServerAddress {
  server: http.Server;
  port: number;
  host: string;
  url: string;
}

export class RuntimeHost extends EventEmitter {
  readonly runStore: RunStore;
  readonly eventStore: EventStore;
  readonly logStore: LogStore;
  readonly collaborationStore: CollaborationStore;
  readonly backend: ExecutionBackend;
  readonly connectProxy: ConnectProxy;
  readonly gateway: McpGateway;
  readonly options: RuntimeHostOptions;
  readonly bootReconcileResult?: ReconcileResult;
  readonly backendAdapter: BackendAvailabilityAdapter;
  readonly admissionAdapter: AdmissionAvailabilityAdapter;

  private isStopped = false;
  private isPausedState = false;
  private gatewayServer: http.Server | null = null;
  private activeGatewayPort: number | null = null;
  private activeGatewayHost: string | null = null;

  private readonly subscribers: Set<(event: EventEnvelope) => void | Promise<void>> =
    new Set();
  private readonly fatalHandlers: Map<
    string,
    (payload: FatalEventPayload) => void | Promise<void>
  > = new Map();
  private readonly supervisors: Set<SkeletonSupervisor> = new Set();
  private readonly onFatalBound: (payload: FatalEventPayload) => void;

  constructor(options: RuntimeHostOptions = {}) {
    super();
    this.options = { ...options };

    this.runStore = options.runStore ?? getDefaultRunStore();
    this.eventStore = options.eventStore ?? getDefaultEventStore();
    this.logStore = options.logStore ?? getDefaultLogStore();
    this.collaborationStore =
      options.collaborationStore ?? new CollaborationStore();

    if (!options.skipReconcile) {
      try {
        this.bootReconcileResult = reconcileOnBoot({ store: this.runStore });
      } catch {
        // preserve constructor stability if runStore has errors
      }
    }

    this.backend =
      options.backend ?? createExecutionBackend(options.backendKind);
    this.connectProxy = new ConnectProxy(options.connectProxyOptions);

    const defaultTimeoutMs = options.defaultTimeoutMs ?? 300000;
    const approvalWaitMs = options.approvalWaitMs ?? 300000;

    // The gateway reports events only through onEmitEvent. RuntimeHost.emitEvent
    // appends each one to this.eventStore once and notifies subscribers. Passing
    // this.eventStore to the gateway as well would make ApprovalManager and
    // execution-tools append every event a second time.
    this.gateway =
      options.gateway ??
      new McpGateway({
        defaultTimeoutMs,
        approvalWaitMs,
        logStore: this.logStore,
        runStore: this.runStore,
        collaborationStore: this.collaborationStore,
        backend: this.backend,
        onEmitEvent: (evt) => {
          this.emitEvent(evt as any);
        },
        ...options.gatewayOptions,
      });

    this.backendAdapter = {
      isAvailable: () => !this.isStopped && !this.isPausedState,
      isHealthy: () => !this.isStopped,
      isPaused: () => this.isPausedState,
      getReason: () => {
        if (this.isStopped) return "RuntimeHost stopped";
        if (this.isPausedState) return "RuntimeHost paused";
        return "OK";
      },
      backend: this.backend,
    };

    const g = globalThis as unknown as {
      __sharedRunStore?: RunStore;
      __sharedEventStore?: EventStore;
      __backend?: BackendAvailabilityAdapter;
      __admission?: AdmissionAvailabilityAdapter;
      __admissionQueue?: unknown[];
      __runOrchestrator?: {
        isAdmissionPaused?: () => boolean;
      };
    };
    if (!Array.isArray(g.__admissionQueue)) {
      g.__admissionQueue = [];
    }
    const sharedQueue = g.__admissionQueue;

    this.admissionAdapter = {
      isPaused: () =>
        this.isPausedState ||
        Boolean(g.__runOrchestrator?.isAdmissionPaused?.()),
      isUnavailable: () => this.isStopped,
      isHealthy: () => !this.isStopped,
      getReason: () => {
        if (this.isStopped) return "RuntimeHost stopped";
        if (this.isPausedState || g.__runOrchestrator?.isAdmissionPaused?.()) {
          return "Paused by owner";
        }
        return "OK";
      },
      getQueueLength: () => sharedQueue.length,
      queue: sharedQueue,
    };

    g.__sharedRunStore = this.runStore;
    g.__sharedEventStore = this.eventStore;
    g.__backend = this.backendAdapter;
    if (!g.__admission) {
      g.__admission = this.admissionAdapter;
    }

    if (options.onEvent) {
      this.subscribers.add(options.onEvent);
    }

    this.onFatalBound = (payload: FatalEventPayload) => {
      void this.handleGatewayFatal(payload);
    };
    this.gateway.on("fatal", this.onFatalBound);
  }

  isPaused(): boolean {
    return this.isPausedState;
  }

  pause(): void {
    this.isPausedState = true;
  }

  resume(): void {
    this.isPausedState = false;
  }

  get stopped(): boolean {
    return this.isStopped;
  }

  get server(): http.Server | null {
    return this.gatewayServer;
  }

  get port(): number | null {
    return this.activeGatewayPort;
  }

  get host(): string | null {
    return this.activeGatewayHost;
  }

  get url(): string | null {
    return this.activeGatewayPort
      ? `http://${this.activeGatewayHost}:${this.activeGatewayPort}`
      : null;
  }

  emitEvent(event: EventInput): EventEnvelope {
    const copy: Record<string, unknown> = {
      runId: event.runId,
      kind: event.kind,
      actor: event.actor,
      data: event.data,
      ts: event.ts,
      seq: event.seq,
      skeletonId: event.skeletonId,
      taskId: event.taskId,
      attempt: event.attempt,
    };

    const redacted = redactEvent(copy);

    const envelope = this.eventStore.append({
      runId: String(redacted.runId),
      kind: String(redacted.kind),
      actor: String(redacted.actor),
      data: (redacted.data as Record<string, unknown>) ?? {},
      ts: typeof redacted.ts === "number" ? redacted.ts : undefined,
      skeletonId:
        typeof redacted.skeletonId === "string"
          ? redacted.skeletonId
          : redacted.skeletonId === null
          ? null
          : undefined,
      taskId:
        typeof redacted.taskId === "string"
          ? redacted.taskId
          : redacted.taskId === null
          ? null
          : undefined,
      attempt:
        typeof redacted.attempt === "number"
          ? redacted.attempt
          : redacted.attempt === null
          ? null
          : undefined,
    });

    for (const subscriber of this.subscribers) {
      try {
        const res = subscriber(envelope);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // ignore subscriber error
      }
    }

    try {
      this.emit("event", envelope);
    } catch {
      // ignore emitter error
    }

    return envelope;
  }

  onEvent(
    subscriber: (event: EventEnvelope) => void | Promise<void>
  ): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  subscribe(
    subscriber: (event: EventEnvelope) => void | Promise<void>
  ): () => void {
    return this.onEvent(subscriber);
  }

  registerFatalHandler(
    runId: string,
    fn: (payload: FatalEventPayload) => void | Promise<void>
  ): void {
    if (!runId || typeof runId !== "string") {
      throw new TypeError("runId is required and must be a non-empty string");
    }
    this.fatalHandlers.set(runId, fn);
  }

  unregisterFatalHandler(runId: string): void {
    if (runId) {
      this.fatalHandlers.delete(runId);
    }
  }

  private async handleGatewayFatal(payload: FatalEventPayload): Promise<void> {
    const targetRunId =
      payload.runId ??
      (payload.skeletonId
        ? this.gateway.getSkeletonById(payload.skeletonId)?.runId
        : undefined);

    if (targetRunId) {
      try {
        this.emitEvent({
          runId: targetRunId,
          kind: "skeleton.failed",
          actor: "RuntimeHost",
          skeletonId: payload.skeletonId,
          data: {
            reason: "quarantined",
            status: "fatal",
            quarantine: true,
            result: payload.result,
            refs: [],
          },
        });
      } catch {
        // ignore emit errors
      }

      const handler = this.fatalHandlers.get(targetRunId);
      if (handler) {
        try {
          await handler(payload);
        } catch {
          // ignore handler errors
        }
      }

      if (this.runStore) {
        try {
          const existing = this.runStore.getRun(targetRunId);
          if (existing && existing.phase !== "done") {
            this.runStore.updateRun(targetRunId, {
              outcome: "error",
              phase: "done",
              endedAt: Date.now(),
            });
          }
        } catch {
          // ignore runStore update errors
        }
      }
    }
  }

  createSupervisor(
    opts: Omit<SkeletonSupervisorOptions, "gateway"> &
      Partial<Pick<SkeletonSupervisorOptions, "gateway">>
  ): SkeletonSupervisor {
    const userOnEvent = opts.onEvent;
    const supervisor = new SkeletonSupervisor({
      ...opts,
      gateway: opts.gateway ?? (this.gateway as any),
      onEvent: async (evt: SkeletonSupervisorEvent) => {
        try {
          const { runId, kind, actor, skeletonId, ...extra } = evt as any;
          this.emitEvent({
            runId: runId ?? opts.runId,
            kind: kind ?? "skeleton.event",
            actor: actor ?? "SkeletonSupervisor",
            skeletonId: skeletonId ?? opts.skeletonId,
            data: extra,
          });
        } catch {
          // ignore forwarding errors
        }
        if (userOnEvent) {
          await userOnEvent(evt);
        }
      },
    });

    this.supervisors.add(supervisor);
    return supervisor;
  }

  async startGatewayServer(
    port = 0,
    host = "127.0.0.1"
  ): Promise<GatewayServerAddress> {
    if (this.gatewayServer) {
      return {
        server: this.gatewayServer,
        port: this.activeGatewayPort!,
        host: this.activeGatewayHost!,
        url: `http://${this.activeGatewayHost}:${this.activeGatewayPort}`,
      };
    }

    const server = createMcpGatewayServer(this.gateway);
    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        const addr = server.address();
        let actualPort = port;
        let actualHost = host;
        if (typeof addr === "object" && addr !== null) {
          actualPort = addr.port;
          actualHost = addr.address;
        }
        this.gatewayServer = server;
        this.activeGatewayPort = actualPort;
        this.activeGatewayHost = actualHost;
        resolve({
          server,
          port: actualPort,
          host: actualHost,
          url: `http://${actualHost}:${actualPort}`,
        });
      });
      server.on("error", reject);
    });
  }

  async start(port = 0, host = "127.0.0.1"): Promise<GatewayServerAddress> {
    return this.startGatewayServer(port, host);
  }

  async startConnectProxy(
    port = 0,
    host = "127.0.0.1"
  ): Promise<{ port: number; host: string; url: string }> {
    return this.connectProxy.start(port, host);
  }

  async stop(options?: { closeStores?: boolean }): Promise<void> {
    if (this.isStopped) {
      return;
    }
    this.isStopped = true;

    try {
      this.gateway.off("fatal", this.onFatalBound);
    } catch {
      // ignore
    }

    if (this.gatewayServer) {
      const s = this.gatewayServer;
      this.gatewayServer = null;
      this.activeGatewayPort = null;
      this.activeGatewayHost = null;
      await new Promise<void>((resolve) => {
        try {
          if (typeof (s as any).closeAllConnections === "function") {
            (s as any).closeAllConnections();
          }
        } catch {
          // ignore
        }
        try {
          if (typeof (s as any).closeIdleConnections === "function") {
            (s as any).closeIdleConnections();
          }
        } catch {
          // ignore
        }
        s.close(() => resolve());
      });
    }

    try {
      await this.connectProxy.stop();
    } catch {
      // ignore
    }

    for (const supervisor of this.supervisors) {
      try {
        if ((supervisor as any).state !== "terminated") {
          await supervisor.cancel("host_shutdown");
        }
      } catch {
        // ignore
      }
    }
    this.supervisors.clear();

    this.subscribers.clear();
    this.fatalHandlers.clear();

    const g = globalThis as unknown as {
      __sharedRunStore?: RunStore;
      __sharedEventStore?: EventStore;
      __backend?: BackendAvailabilityAdapter;
      __admission?: AdmissionAvailabilityAdapter;
    };
    if (g.__sharedRunStore === this.runStore) {
      g.__sharedRunStore = undefined;
    }
    if (g.__sharedEventStore === this.eventStore) {
      g.__sharedEventStore = undefined;
    }
    if (g.__backend === this.backendAdapter) {
      g.__backend = undefined;
    }
    if (g.__admission === this.admissionAdapter) {
      g.__admission = undefined;
    }

    const shouldClose =
      options?.closeStores ?? this.options.closeStoresOnShutdown ?? false;
    if (shouldClose) {
      try {
        if (typeof this.eventStore?.close === "function") {
          this.eventStore.close();
        }
      } catch {
        // ignore
      }
      try {
        if (typeof this.runStore?.close === "function") {
          this.runStore.close();
        }
      } catch {
        // ignore
      }
    }
  }

  async shutdown(options?: { closeStores?: boolean }): Promise<void> {
    return this.stop(options);
  }
}

let defaultRuntimeHostInstance: RuntimeHost | null = null;

export function getRuntimeHost(options?: RuntimeHostOptions): RuntimeHost {
  if (!defaultRuntimeHostInstance) {
    defaultRuntimeHostInstance = new RuntimeHost(options);
  }
  return defaultRuntimeHostInstance;
}

export function createRuntimeHost(options?: RuntimeHostOptions): RuntimeHost {
  return new RuntimeHost(options);
}

export async function resetRuntimeHost(options?: {
  closeStores?: boolean;
}): Promise<void> {
  if (defaultRuntimeHostInstance) {
    const host = defaultRuntimeHostInstance;
    defaultRuntimeHostInstance = null;
    await host.shutdown(options);
  }
}
