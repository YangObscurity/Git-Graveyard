// Work package SB1: the MCP gateway names the Skeleton and the run in fatal
// events, authenticates the bearer token before reading the request body and
// caps that body at 1 MiB, and no longer falls back to an in-memory LogStore.
// Audit items N-B1 (gateway side), N-B6, M-3 (LogStore).
//
// The fatal payload tests drive the real handleToolCall path (same fixture
// pattern as mcp-gateway-r5b4.test.ts): a fatal sandbox result must emit
// "fatal" exactly once with a { skeletonId, runId, result } payload naming
// the calling Skeleton. The HTTP tests drive the real createMcpGatewayServer
// handler over loopback: an unauthenticated request must not read its body
// (reads on the request stream are recorded), an oversized body gets 413
// while a body of exactly 1 MiB still reaches the dispatcher, and a gateway
// built without a LogStore must fail with ConfigurationError.

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import {
  ConfigurationError,
  createMcpGatewayServer,
  McpGateway,
} from "../../lib/gateway/mcp-gateway";
import { LogStore } from "../../lib/events/log-store";

const ONE_MIB = 1024 * 1024;

/**
 * Builds a gateway fixture: a real McpGateway, a registered Soul-stitcher
 * skeleton bound to a real temp worktree, and a fake runbox whose run
 * optionally drops a file with a secret pattern into the worktree (which the
 * post-exec secret scan reports as a fatal result).
 */
interface GatewayFixture {
  gateway: McpGateway;
  bearerToken: string;
  worktreeDir: string;
  baseDir: string;
}

function buildGatewayFixture(dropSecretOnRun: boolean): GatewayFixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb1-gw-"));
  const worktreeDir = path.join(baseDir, "wt");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "task.md"), "sample task", "utf-8");

  const secretFile = path.join(worktreeDir, "leaked.txt");
  const fakeRunbox = {
    run: async () => {
      if (dropSecretOnRun) {
        // AWS access key pattern (AKIA followed by 16 uppercase/digits)
        fs.writeFileSync(secretFile, 'aws_key = "AKIAABCDEFGHIJKLMNOP"\n', "utf-8");
      }
      return {
        exitCode: 0,
        stdoutTail: "executed git status in runbox",
        stderrTail: "",
        timedOut: false,
      };
    },
  };

  const gateway = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
    runbox: fakeRunbox as any,
  });

  const skeleton = gateway.registerSkeleton({
    skeletonId: "skel-sb1-gw",
    role: "Soul-stitcher",
    worktreeRoot: worktreeDir,
    runId: "run-sb1-gw",
  });

  return {
    gateway,
    bearerToken: skeleton.bearerToken,
    worktreeDir,
    baseDir,
  };
}

function cleanupFixture(baseDir: string): void {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

/**
 * Builds an HTTP fixture: a real McpGateway with a registered Skeleton and a
 * real loopback MCP server on an ephemeral port.
 */
interface HttpFixture {
  gateway: McpGateway;
  server: http.Server;
  port: number;
  bearerToken: string;
  baseDir: string;
}

async function buildHttpFixture(): Promise<HttpFixture> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb1-http-"));
  const worktreeDir = path.join(baseDir, "wt");
  fs.mkdirSync(worktreeDir, { recursive: true });

  const gateway = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
  });

  const skeleton = gateway.registerSkeleton({
    skeletonId: "skel-sb1-http",
    role: "Soul-stitcher",
    worktreeRoot: worktreeDir,
    runId: "run-sb1-http",
  });

  const server = createMcpGatewayServer(gateway);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as net.AddressInfo;

  return {
    gateway,
    server,
    port: address.port,
    bearerToken: skeleton.bearerToken,
    baseDir,
  };
}

async function cleanupHttpFixture(fixture: HttpFixture): Promise<void> {
  await new Promise<void>((resolve) => {
    serverClose(fixture.server, resolve);
  });
  fs.rmSync(fixture.baseDir, { recursive: true, force: true });
}

function serverClose(server: http.Server, onClosed: () => void): void {
  server.close(() => onClosed());
  // Node 18+: tear down lingering keep-alive sockets so close() completes.
  server.closeAllConnections();
}

/**
 * POSTs a raw string body as JSON to the MCP server and resolves with the
 * HTTP status and response body. Socket teardown noise after the response
 * has been received is tolerated; the status and body assertions are not.
 */
function postRaw(
  port: number,
  bearerToken: string,
  body: string
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        // The response has arrived; later socket teardown must not fail the
        // request promise.
        request.removeAllListeners("error");
        request.on("error", () => {});
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
        res.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("SB1: the fatal payload carries the skeletonId and runId of the calling Skeleton", async () => {
  const fixture = buildGatewayFixture(true);
  try {
    const emissions: Array<Record<string, unknown>> = [];
    fixture.gateway.on("fatal", (payload: unknown) => {
      emissions.push(payload as Record<string, unknown>);
    });

    const returned = (await fixture.gateway.handleToolCall(
      fixture.bearerToken,
      "sandbox_exec",
      { argv: ["git", "status"], cwd: fixture.worktreeDir }
    )) as { status: string };

    assert.equal(returned.status, "fatal", "The tool result must be fatal");
    assert.equal(
      emissions.length,
      1,
      "Exactly one fatal event must be emitted for one fatal tool result"
    );
    assert.equal(
      emissions[0]["skeletonId"],
      "skel-sb1-gw",
      "The payload must name the Skeleton that made the call"
    );
    assert.equal(
      emissions[0]["runId"],
      "run-sb1-gw",
      "The payload must name the run of that Skeleton"
    );
    assert.equal(
      emissions[0]["result"],
      returned,
      "The payload result must be the same result object returned to the caller"
    );
  } finally {
    cleanupFixture(fixture.baseDir);
  }
});

test("SB1: a bearer token without a Skeleton mapping emits nothing", async () => {
  const fixture = buildGatewayFixture(false);
  try {
    const emissions: unknown[] = [];
    fixture.gateway.on("fatal", (payload: unknown) => {
      emissions.push(payload);
    });

    const returned = (await fixture.gateway.handleToolCall(
      "skel-token-never-registered",
      "sandbox_exec",
      { argv: ["git", "status"], cwd: fixture.worktreeDir }
    )) as { status: string };

    assert.equal(returned.status, "refused");
    assert.equal(
      emissions.length,
      0,
      "A token without a Skeleton mapping must not emit anything"
    );
  } finally {
    cleanupFixture(fixture.baseDir);
  }
});

test("SB1: an unauthenticated request does not read its body", async () => {
  const fixture = await buildHttpFixture();
  try {
    const bodyReads: string[] = [];
    const seenReq: { req: http.IncomingMessage | null } = { req: null };
    // Record reads on the request stream. The recorder is prepended so it
    // wraps the stream before the gateway handler runs: any attempt by the
    // handler to consume the body (attaching data/readable listeners or
    // calling read) is recorded. Reads are recorded only while the request is
    // still being handled, that is before the gateway starts writing its
    // response: once the response is out, Node itself drains an unconsumed
    // request body at socket teardown (resume_/flow inside
    // node:internal/streams/readable), and that internal drain is not a
    // handler read of the body.
    fixture.server.prependListener(
      "request",
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        seenReq.req = req;
        let responseStarted = false;
        const originalWriteHead = res.writeHead.bind(res) as (
          ...args: unknown[]
        ) => http.ServerResponse;
        res.writeHead = ((...args: unknown[]) => {
          responseStarted = true;
          return originalWriteHead(...args);
        }) as typeof res.writeHead;
        const originalEnd = res.end.bind(res) as (
          ...args: unknown[]
        ) => http.ServerResponse;
        res.end = ((...args: unknown[]) => {
          responseStarted = true;
          return originalEnd(...args);
        }) as typeof res.end;

        const record = (what: string): void => {
          if (!responseStarted) {
            bodyReads.push(what);
          }
        };
        const recordOn = (event: string | symbol): void => {
          if (event === "data" || event === "readable") {
            record(`on(${String(event)})`);
          }
        };
        const originalOn = req.on.bind(req) as (
          event: string | symbol,
          listener: (...args: unknown[]) => void,
          ...rest: unknown[]
        ) => http.IncomingMessage;
        req.on = function (
          event: string | symbol,
          listener: (...args: unknown[]) => void,
          ...rest: unknown[]
        ) {
          recordOn(event);
          return originalOn(event, listener, ...rest);
        } as typeof req.on;
        const originalAddListener = req.addListener.bind(req) as (
          event: string | symbol,
          listener: (...args: unknown[]) => void,
          ...rest: unknown[]
        ) => http.IncomingMessage;
        req.addListener = function (
          event: string | symbol,
          listener: (...args: unknown[]) => void,
          ...rest: unknown[]
        ) {
          recordOn(event);
          return originalAddListener(event, listener, ...rest);
        } as typeof req.addListener;
        const originalRead = req.read.bind(req);
        req.read = (size?: number) => {
          record("read()");
          return originalRead(size);
        };
      }
    );

    // The client declares a 64-byte body but never sends it: if the gateway
    // tried to read the body, it would wait for bytes that never arrive and
    // no response would come back.
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("no response within 2000 ms; the gateway waited on the body"));
      }, 2000);
      const request = http.request(
        {
          host: "127.0.0.1",
          port: fixture.port,
          method: "POST",
          path: "/",
          headers: {
            Authorization: "Bearer not-a-registered-token",
            "Content-Type": "application/json",
            "Content-Length": "64",
          },
        },
        (res) => {
          clearTimeout(timer);
          resolve(res);
        }
      );
      request.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      request.flushHeaders();
    });

    const responseBody = await new Promise<string>((resolve, reject) => {
      let data = "";
      response.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      response.on("end", () => resolve(data));
      response.on("error", reject);
    });

    assert.equal(response.statusCode, 401);
    assert.ok(
      /bearer token/i.test(responseBody),
      "The 401 must say the bearer token was not recognized"
    );
    assert.ok(seenReq.req, "The recorder must have seen the request stream");
    assert.deepEqual(
      bodyReads,
      [],
      "The gateway must not read the body of an unauthenticated request"
    );
  } finally {
    await cleanupHttpFixture(fixture);
  }
});

test("SB1: an oversized body gets 413", async () => {
  const fixture = await buildHttpFixture();
  try {
    const body = "x".repeat(ONE_MIB + 16);
    const result = await postRaw(fixture.port, fixture.bearerToken, body);
    assert.equal(result.status, 413);
    const parsed = JSON.parse(result.body) as { error?: string };
    assert.match(
      parsed.error ?? "",
      /1 MiB/,
      "The 413 response must say the body exceeds the 1 MiB limit"
    );
  } finally {
    await cleanupHttpFixture(fixture);
  }
});

test("SB1: a body of exactly 1 MiB is not oversized and reaches the dispatcher", async () => {
  const fixture = await buildHttpFixture();
  try {
    // Build a JSON body of exactly ONE_MIB bytes (the template carries a
    // one-char pad that is replaced by the padding).
    const template = JSON.stringify({
      tool: "definitely_unknown_tool_sb1",
      arguments: { pad: "@" },
    });
    const padLength = ONE_MIB - Buffer.byteLength(template) + 1;
    const body = template.replace('"@"', `"${"x".repeat(padLength)}"`);
    assert.equal(
      Buffer.byteLength(body),
      ONE_MIB,
      "The boundary body must be exactly 1 MiB"
    );

    const result = await postRaw(fixture.port, fixture.bearerToken, body);
    assert.equal(result.status, 200, "A body of exactly 1 MiB must not be rejected as oversized");
    const parsed = JSON.parse(result.body) as { status?: string };
    assert.equal(
      parsed.status,
      "refused",
      "The call must reach the dispatcher (unknown tool is refused there)"
    );
  } finally {
    await cleanupHttpFixture(fixture);
  }
});

test("SB1: a missing LogStore throws ConfigurationError", () => {
  assert.throws(
    () => new McpGateway({ defaultTimeoutMs: 60000, approvalWaitMs: 300000 }),
    (err: unknown) =>
      err instanceof ConfigurationError && /logStore/i.test(err.message)
  );
});
