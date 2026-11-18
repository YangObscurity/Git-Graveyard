// Work package SB3 (audit N-B2): the ACP client's fallback handler for
// engine-to-client requests answers only the `_kiro` methods the production
// path and the recorded probes know. The probes recorded exactly one such
// request: `_kiro/terminal/shell_type` (P6, P12). Every other method gets a
// JSON-RPC -32601 error instead of the former `{ ok: true }` default, and
// permission requests keep their own broker handler; the fallback never
// answers them.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  AcpClient,
  ACP_SHELL_TYPE,
  type AcpClientOptions,
} from "../../lib/supervisor/acp-client";
import { AcpTransport } from "../../lib/supervisor/acp-transport";
import type { ChildProcessLike } from "../../lib/supervisor/types";

class MockChildProcess extends EventEmitter implements ChildProcessLike {
  public stdin: PassThrough = new PassThrough();
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public pid: number = 4321;
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | string | null = null;

  public send(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  public kill(): boolean {
    this.killed = true;
    return true;
  }
}

function collectClientMessages(child: MockChildProcess): any[] {
  const messages: any[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString("utf-8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // ignore partial lines
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  return messages;
}

function makeClient(
  options: Partial<AcpClientOptions> = {}
): { child: MockChildProcess; client: AcpClient; messages: any[] } {
  const child = new MockChildProcess();
  const messages = collectClientMessages(child);
  const transport = new AcpTransport(child);
  const client = new AcpClient(transport, { watchdogLimitMs: 5000, ...options });
  return { child, client, messages };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SB3: the _kiro fallback handler answers only known methods (audit N-B2)", () => {
  it("answers an unknown _kiro method with -32601 instead of the old ok default", async () => {
    const { child, messages } = makeClient();

    child.send({
      jsonrpc: "2.0",
      id: 8,
      method: "_kiro/session/context",
      params: {},
    });
    await waitFor(() => messages.some((m) => m.id === 8));

    const answer = messages.find((m) => m.id === 8);
    assert.ok(answer, "an unknown _kiro method must still get an answer");
    assert.equal(answer.error?.code, -32601);
    assert.equal(answer.result, undefined);
  });

  it("keeps answering _kiro/terminal/shell_type (probe P6)", async () => {
    const { child, messages } = makeClient();

    child.send({
      jsonrpc: "2.0",
      id: 7,
      method: "_kiro/terminal/shell_type",
      params: { sessionId: "s1" },
    });
    await waitFor(() => messages.some((m) => m.id === 7));

    const answer = messages.find((m) => m.id === 7);
    assert.ok(answer, "the client must answer the shell-type request");
    assert.deepEqual(answer.result, { shellType: ACP_SHELL_TYPE });
    assert.equal(answer.error, undefined);
  });

  it("never answers a permission method from the fallback handler", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sb3-perm-"));
    try {
      const { child, client, messages } = makeClient({
        role: "Planner",
        cwd,
        runId: "run-sb3-perm",
      });
      const fallbackSeen: string[] = [];
      client.on("client_request", (e: any) =>
        fallbackSeen.push(String(e?.method))
      );

      child.send({
        jsonrpc: "2.0",
        id: 11,
        method: "session/request_permission",
        params: {
          sessionId: "sess-sb3-1",
          capability: "fs_read",
          target: "/etc/shadow",
          options: [
            { optionId: "opt-deny", kind: "reject_once" },
            { optionId: "opt-allow", kind: "allow_once" },
          ],
        },
      });
      await waitFor(() => messages.some((m) => m.id === 11));

      const answer = messages.find((m) => m.id === 11);
      assert.ok(
        answer,
        "the permission request must still be answered by its own handler"
      );
      assert.equal(
        answer.error,
        undefined,
        "the permission handler, not the fallback, answers"
      );
      assert.notDeepEqual(answer.result, { ok: true });
      assert.ok(
        answer.result &&
          typeof answer.result === "object" &&
          answer.result.outcome,
        "the answer must be a broker decision"
      );
      assert.equal(
        fallbackSeen.includes("session/request_permission"),
        false,
        "the fallback handler must not see a permission method"
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
