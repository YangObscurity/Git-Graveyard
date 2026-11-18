// Work package RB5: Second-round B-audit fixes for McpGateway (N-B10 / N-B15).
// N-B10: registerSkeleton requires non-empty skeletonId, rejects duplicate skeletonId,
//        requires non-empty bearerToken/runId when provided, and rejects duplicate bearerToken.
// N-B15: createMcpGatewayServer destroys request on 413 (both declared and streaming oversized),
//        and 500 catch block returns generic { error: "Internal server error" } without leaking
//        internal error message or sensitive details.

import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import {
  createMcpGatewayServer,
  McpGateway,
} from "../../lib/gateway/mcp-gateway";
import { LogStore } from "../../lib/events/log-store";

const ONE_MIB = 1024 * 1024;

interface HttpFixture {
  gateway: McpGateway;
  server: http.Server;
  port: number;
  bearerToken: string;
  baseDir: string;
  worktreeDir: string;
  capturedRequests: http.IncomingMessage[];
}

async function buildHttpFixture(): Promise<HttpFixture> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb5-http-"));
  const worktreeDir = path.join(baseDir, "wt");
  fs.mkdirSync(worktreeDir, { recursive: true });

  const gateway = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
  });

  const skeleton = gateway.registerSkeleton({
    skeletonId: "skel-rb5-http",
    role: "Soul-stitcher",
    worktreeRoot: worktreeDir,
    runId: "run-rb5-http",
  });

  const capturedRequests: http.IncomingMessage[] = [];
  const server = createMcpGatewayServer(gateway);
  server.prependListener("request", (req: http.IncomingMessage) => {
    capturedRequests.push(req);
  });

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
    worktreeDir,
    capturedRequests,
  };
}

async function cleanupHttpFixture(fixture: HttpFixture): Promise<void> {
  await new Promise<void>((resolve) => {
    fixture.server.close(() => resolve());
    fixture.server.closeAllConnections();
  });
  fs.rmSync(fixture.baseDir, { recursive: true, force: true });
}

function postRequest(
  port: number,
  bearerToken: string,
  options: {
    body?: string | Buffer;
    headers?: Record<string, string>;
    chunks?: Buffer[];
  }
): Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    };

    if (options.body !== undefined && !headers["Content-Length"]) {
      headers["Content-Length"] = Buffer.byteLength(options.body).toString();
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers,
      },
      (res) => {
        req.removeAllListeners("error");
        req.on("error", () => {});
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        res.on("error", reject);
      }
    );

    req.on("error", () => {
      // Client connection error can occur when server destroys the socket.
    });

    if (options.chunks) {
      for (const c of options.chunks) {
        req.write(c);
      }
      req.end();
    } else if (options.body !== undefined) {
      req.end(options.body);
    } else {
      req.end();
    }
  });
}

test("RB5: registerSkeleton requires non-empty skeletonId (N-B10)", () => {
  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
  });

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "",
        role: "Soul-stitcher",
        worktreeRoot: "/workspace/repo",
      }),
    /skeletonId is required/i
  );

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "   ",
        role: "Soul-stitcher",
        worktreeRoot: "/workspace/repo",
      }),
    /skeletonId is required/i
  );

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: undefined as unknown as string,
        role: "Soul-stitcher",
        worktreeRoot: "/workspace/repo",
      }),
    /skeletonId is required/i
  );
});

test("RB5: registerSkeleton rejects duplicate skeletonId (N-B10)", () => {
  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
  });

  const reg1 = gw.registerSkeleton({
    skeletonId: "skel-unique-1",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
  });
  assert.equal(reg1.skeletonId, "skel-unique-1");

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-unique-1",
        role: "Warden",
        worktreeRoot: "/workspace/repo",
      }),
    /duplicate skeletonId/i
  );

  // Verify first registration is not overwritten
  const lookedUp = gw.getSkeletonById("skel-unique-1");
  assert.equal(lookedUp?.role, "Soul-stitcher");
  assert.equal(lookedUp?.bearerToken, reg1.bearerToken);

  // Trimmed duplicate skeletonId rejection: whitespace padding cannot bypass duplicate check
  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "  skel-unique-1  ",
        role: "Warden",
        worktreeRoot: "/workspace/repo",
      }),
    /duplicate skeletonId/i
  );

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: " skel-unique-1",
        role: "Warden",
        worktreeRoot: "/workspace/repo",
      }),
    /duplicate skeletonId/i
  );
});

test("RB5: registerSkeleton stores trimmed skeletonId so untrimmed first registration cannot be duplicated", () => {
  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
  });

  const reg = gw.registerSkeleton({
    skeletonId: "  skel-pre-padded  ",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
  });
  assert.equal(reg.skeletonId, "skel-pre-padded");

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-pre-padded",
        role: "Warden",
        worktreeRoot: "/workspace/repo",
      }),
    /duplicate skeletonId/i
  );
});

test("RB5: registerSkeleton requires non-empty bearerToken and rejects duplicate bearerToken (N-B10)", () => {
  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
  });

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-empty-tok",
        role: "Soul-stitcher",
        worktreeRoot: "/workspace/repo",
        bearerToken: "",
      }),
    /bearerToken must be non-empty/i
  );

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-ws-tok",
        role: "Soul-stitcher",
        worktreeRoot: "/workspace/repo",
        bearerToken: "   ",
      }),
    /bearerToken must be non-empty/i
  );

  const regA = gw.registerSkeleton({
    skeletonId: "skel-a",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    bearerToken: "custom-token-alpha",
  });
  assert.equal(regA.bearerToken, "custom-token-alpha");

  // Attempting to register another skeleton with identical token fails
  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-b",
        role: "Warden",
        worktreeRoot: "/workspace/repo",
        bearerToken: "custom-token-alpha",
      }),
    /duplicate bearerToken/i
  );

  // Attempting with surrounding whitespace also fails duplicate check
  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-c",
        role: "Warden",
        worktreeRoot: "/workspace/repo",
        bearerToken: "  custom-token-alpha  ",
      }),
    /duplicate bearerToken/i
  );

  // Attempting to register token colliding with an auto-generated token fails
  const autoReg = gw.registerSkeleton({
    skeletonId: "skel-auto",
    role: "Exhumer",
    worktreeRoot: "/workspace/repo",
  });

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-d",
        role: "Warden",
        worktreeRoot: "/workspace/repo",
        bearerToken: autoReg.bearerToken,
      }),
    /duplicate bearerToken/i
  );
});

test("RB5: registerSkeleton requires non-empty runId when provided (N-B10)", () => {
  const gw = new McpGateway({
    defaultTimeoutMs: 60000,
    approvalWaitMs: 300000,
    logStore: new LogStore({ inMemory: true }),
  });

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-empty-run",
        role: "Soul-stitcher",
        worktreeRoot: "/workspace/repo",
        runId: "",
      }),
    /runId must be non-empty/i
  );

  assert.throws(
    () =>
      gw.registerSkeleton({
        skeletonId: "skel-ws-run",
        role: "Soul-stitcher",
        worktreeRoot: "/workspace/repo",
        runId: "   ",
      }),
    /runId must be non-empty/i
  );

  const regValid = gw.registerSkeleton({
    skeletonId: "skel-valid-run",
    role: "Soul-stitcher",
    worktreeRoot: "/workspace/repo",
    runId: "run-rb5-valid",
  });
  assert.equal(regValid.runId, "run-rb5-valid");
});

test("RB5: declared oversized request returns 413, Connection: close, and destroys request stream (N-B15)", async () => {
  const fixture = await buildHttpFixture();
  try {
    const declaredSize = ONE_MIB + 2048;
    const body = "y".repeat(declaredSize);

    const res = await postRequest(fixture.port, fixture.bearerToken, {
      body,
      headers: {
        "Content-Length": declaredSize.toString(),
      },
    });

    assert.equal(res.status, 413);
    assert.equal(res.headers["connection"], "close");
    const parsed = JSON.parse(res.body) as { error?: string };
    assert.match(parsed.error ?? "", /1 MiB/);

    // Verify server called req.destroy() on the oversized request stream
    assert.equal(fixture.capturedRequests.length, 1);
    assert.equal(
      fixture.capturedRequests[0].destroyed,
      true,
      "Request stream must be destroyed so oversized bodies are not drained"
    );
  } finally {
    await cleanupHttpFixture(fixture);
  }
});

test("RB5: streaming oversized request returns 413, Connection: close, and destroys request stream (N-B15)", async () => {
  const fixture = await buildHttpFixture();
  try {
    const chunk1 = Buffer.alloc(ONE_MIB / 2, "a");
    const chunk2 = Buffer.alloc(ONE_MIB / 2 + 1024, "b");

    const res = await postRequest(fixture.port, fixture.bearerToken, {
      chunks: [chunk1, chunk2],
      headers: {
        "Transfer-Encoding": "chunked",
      },
    });

    assert.equal(res.status, 413);
    assert.equal(res.headers["connection"], "close");
    const parsed = JSON.parse(res.body) as { error?: string };
    assert.match(parsed.error ?? "", /1 MiB/);

    // Verify server called req.destroy() on the stream
    assert.equal(fixture.capturedRequests.length, 1);
    assert.equal(
      fixture.capturedRequests[0].destroyed,
      true,
      "Streaming request stream must be destroyed once limit is exceeded"
    );
  } finally {
    await cleanupHttpFixture(fixture);
  }
});

test("RB5: 400 handler returns Bad Request on malformed JSON", async () => {
  const fixture = await buildHttpFixture();
  try {
    const malformedBody = '{"tool": "sandbox_exec", invalid_json';
    const res = await postRequest(fixture.port, fixture.bearerToken, {
      body: malformedBody,
    });

    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body) as { error?: string };
    assert.deepEqual(parsed, { error: "Invalid JSON body" });
  } finally {
    await cleanupHttpFixture(fixture);
  }
});

test("RB5: 500 handler returns generic 'Internal server error' without leaking internal details (N-B15)", async () => {
  const fixture = await buildHttpFixture();
  try {
    // Stub handleToolCall to throw an error with sensitive internal details
    fixture.gateway.handleToolCall = async () => {
      throw new Error(
        "DB_CONNECTION_FAILURE: connection to postgresql://admin:SECRET_PASSWORD_123@internal.db failed at /var/secrets/key.pem"
      );
    };

    const validToolBody = JSON.stringify({
      tool: "sandbox_exec",
      arguments: { argv: ["git", "status"], cwd: fixture.worktreeDir },
    });

    const res = await postRequest(fixture.port, fixture.bearerToken, {
      body: validToolBody,
    });

    assert.equal(res.status, 500);
    const parsed = JSON.parse(res.body) as { error?: string };
    assert.deepEqual(parsed, { error: "Internal server error" });

    // Assert that NONE of the raw error details are exposed over HTTP
    assert.doesNotMatch(res.body, /DB_CONNECTION_FAILURE/);
    assert.doesNotMatch(res.body, /SECRET_PASSWORD_123/);
    assert.doesNotMatch(res.body, /postgresql/);
    assert.doesNotMatch(res.body, /secrets/);
  } finally {
    await cleanupHttpFixture(fixture);
  }
});
