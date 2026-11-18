// Task 9.4: ACP stdio transport layer
// Requirements: 16.1, 16.2, 16.3, 16.4

import { EventEmitter } from "node:events";
import type { ChildProcessLike } from "./types";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

export type RequestHandler = (
  params: unknown,
  id: string | number
) => Promise<unknown> | unknown;

/**
 * Last-resort handler for incoming requests with no method-specific handler.
 * It receives the method name so it can serve a whole namespace (for example
 * kiro-cli's client duties on `_kiro/*`) without one registration per method.
 */
export type FallbackRequestHandler = (
  method: string,
  params: unknown,
  id: string | number
) => Promise<unknown> | unknown;

export type NotificationHandler = (params: unknown) => Promise<void> | void;

interface PendingRequest {
  id: string | number;
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Transport for newline-delimited JSON-RPC 2.0 communication over child process stdio.
 */
export class AcpTransport extends EventEmitter {
  private childProcess: ChildProcessLike;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestHandlers: Map<string, RequestHandler> = new Map();
  private fallbackRequestHandler?: FallbackRequestHandler;
  private notificationHandlers: Map<string, Set<NotificationHandler>> = new Map();
  private nextRequestId: number = 1;
  private stdoutBuffer: string = "";
  private closed: boolean = false;

  constructor(childProcess: ChildProcessLike) {
    super();
    this.childProcess = childProcess;
    this.setupListeners();
  }

  private setupListeners(): void {
    if (this.childProcess.stdout) {
      this.childProcess.stdout.on("data", (chunk: Buffer | string) => {
        this.handleStdoutData(chunk);
      });
      this.childProcess.stdout.on("error", (err: unknown) => {
        this.emit("error", err);
      });
    }

    if (this.childProcess.stderr) {
      this.childProcess.stderr.on("data", (chunk: Buffer | string) => {
        this.emit("stderr", chunk.toString());
      });
    }

    this.childProcess.on("exit", (code: number | null, signal: NodeJS.Signals | string | null) => {
      this.handleProcessExit(code, signal);
    });

    this.childProcess.on("error", (err: unknown) => {
      this.emit("error", err);
    });
  }

  private handleStdoutData(chunk: Buffer | string): void {
    this.stdoutBuffer += chunk.toString("utf-8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.handleLine(line);
      }

      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      this.dispatchMessage(parsed as JsonRpcMessage);
    } catch (err) {
      this.emit("parseError", { error: err, line });
    }
  }

  private async dispatchMessage(msg: JsonRpcMessage): Promise<void> {
    // 1. Is this a response to a pending request?
    if ("id" in msg && msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const key = String(msg.id);
      const pending = this.pendingRequests.get(key);
      if (pending) {
        this.pendingRequests.delete(key);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        if (msg.error) {
          const err = new Error(msg.error.message ?? "JSON-RPC error");
          (err as any).code = msg.error.code;
          (err as any).data = msg.error.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // 2. Is this an incoming request from the agent?
    if ("id" in msg && msg.id !== undefined && "method" in msg && typeof (msg as JsonRpcRequest).method === "string") {
      const req = msg as JsonRpcRequest;
      const handler = this.requestHandlers.get(req.method);
      if (handler) {
        try {
          const result = await handler(req.params, req.id);
          this.sendResponse(req.id, result);
        } catch (err: any) {
          this.sendError(
            req.id,
            typeof err?.code === "number" ? err.code : -32000,
            err?.message ?? "Internal error",
            err?.data
          );
        }
      } else if (this.fallbackRequestHandler) {
        // Method-aware last resort. kiro-cli 3.1.0 has client duties on its own
        // `_kiro/*` namespace (for example `_kiro/terminal/shell_type`); without
        // an answer the session stalls before the first tool call.
        try {
          const result = await this.fallbackRequestHandler(req.method, req.params, req.id);
          this.sendResponse(req.id, result);
        } catch (err: any) {
          this.sendError(
            req.id,
            typeof err?.code === "number" ? err.code : -32000,
            err?.message ?? "Internal error",
            err?.data
          );
        }
      } else {
        // Requirement 16.4: Answer every incoming fs/*, terminal/* and unknown client request with JSON-RPC error
        this.sendError(
          req.id,
          -32601,
          `Method "${req.method}" not supported`
        );
      }
      return;
    }

    // 3. Is this a notification?
    if (typeof (msg as JsonRpcNotification).method === "string" && !("id" in msg)) {
      const method = (msg as JsonRpcNotification).method;
      const handlers = this.notificationHandlers.get(method);
      if (handlers) {
        for (const h of handlers) {
          try {
            await h(msg.params);
          } catch (err) {
            this.emit("handlerError", { method, error: err });
          }
        }
      }
      this.emit("notification", { method, params: msg.params });
    }
  }

  /**
   * Registers a handler for incoming JSON-RPC requests from the agent.
   */
  public registerRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Registers a last-resort handler used when no method-specific handler exists.
   * It must throw (with a JSON-RPC code) for methods it refuses, so requirement
   * 16.4 still answers unknown client requests with an error.
   */
  public registerFallbackRequestHandler(handler: FallbackRequestHandler): void {
    this.fallbackRequestHandler = handler;
  }

  /**
   * Registers a listener for incoming JSON-RPC notifications.
   */
  public registerNotificationHandler(
    method: string,
    handler: NotificationHandler
  ): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  /**
   * Sends a JSON-RPC request to the child process and awaits the response.
   */
  public sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = 0
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot send request "${method}": transport closed`));
    }

    const id = this.nextRequestId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(String(id));
          reject(new Error(`ACP request "${method}" (id: ${id}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingRequests.set(String(id), {
        id,
        method,
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      this.writeMessage(message);
    });
  }

  /**
   * Sends a JSON-RPC notification.
   */
  public sendNotification(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writeMessage(message);
  }

  /**
   * Sends a successful JSON-RPC response.
   */
  public sendResponse(id: string | number, result: unknown): void {
    if (this.closed) {
      return;
    }
    const message: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      result: result ?? null,
    };
    this.writeMessage(message);
  }

  /**
   * Sends a JSON-RPC error response.
   */
  public sendError(
    id: string | number,
    code: number,
    message: string,
    data?: unknown
  ): void {
    if (this.closed) {
      return;
    }
    const payload: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    };
    this.writeMessage(payload);
  }

  private writeMessage(msg: JsonRpcMessage): void {
    if (!this.childProcess.stdin || !this.childProcess.stdin.writable) {
      this.emit("error", new Error("Cannot write to child process stdin: not writable"));
      return;
    }
    const line = JSON.stringify(msg) + "\n";
    this.childProcess.stdin.write(line, "utf-8");
  }

  private handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | string | null
  ): void {
    this.closed = true;
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(
        new Error(
          `ACP process exited before reply to "${pending.method}" (code: ${code}, signal: ${signal})`
        )
      );
    }
    this.pendingRequests.clear();
    this.emit("exit", { code, signal });
  }

  /**
   * Closes the transport and clears pending state.
   */
  public close(): void {
    this.closed = true;
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new Error("ACP transport closed"));
    }
    this.pendingRequests.clear();
    this.requestHandlers.clear();
    this.fallbackRequestHandler = undefined;
    this.notificationHandlers.clear();
  }
}
