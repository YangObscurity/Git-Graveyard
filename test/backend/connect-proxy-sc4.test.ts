// SC4: CONNECT proxy port restriction (audit item N-C8).
// By default CONNECT accepts only ports 443 and 80. An allowlist entry with
// a ports field is honored for exactly those ports. Any other port gets 403.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import {
  createConnectProxy,
  evaluateConnectTarget,
  type ConnectProxyOptions,
  type HostEvaluationResult,
} from "../../lib/backend/connect-proxy";

interface ConnectReply {
  status: number;
  body: string;
}

/**
 * Send a raw CONNECT request to the proxy and resolve with the HTTP reply
 * status and body as soon as the header block arrives. The socket is then
 * drained until the proxy closes it, so no reset is sent back into the
 * proxy while it finishes its response. A tunnel reply (200) is torn down
 * immediately; the proxy handles the resulting client error itself.
 */
function sendConnectRequest(
  proxyPort: number,
  target: string
): Promise<ConnectReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    let raw = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    socket.setTimeout(10000);
    socket.on("connect", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const statusLine = raw.slice(0, raw.indexOf("\r\n"));
        const status = parseInt(statusLine.split(" ")[1], 10);
        if (status === 200) {
          socket.destroy();
        }
        settle(() => resolve({ status, body: raw.slice(headerEnd + 4) }));
      }
    });
    socket.on("end", () => {
      socket.end();
    });
    socket.on("close", () => {
      settle(() => reject(new Error("connection closed before any reply")));
    });
    socket.on("timeout", () => {
      socket.destroy();
      settle(() => reject(new Error("timed out waiting for CONNECT reply")));
    });
    socket.on("error", (err: Error) => {
      settle(() => reject(err));
    });
  });
}

interface ProxyEvents {
  allowed: Array<{ host: string; port?: number }>;
  blocked: HostEvaluationResult[];
}

function eventsCollector(): { events: ProxyEvents; onAllowed: ConnectProxyOptions["onAllowed"]; onBlocked: ConnectProxyOptions["onBlocked"] } {
  const events: ProxyEvents = { allowed: [], blocked: [] };
  return {
    events,
    onAllowed: (dest) => {
      events.allowed.push({ host: dest.host, port: dest.port });
    },
    onBlocked: (result) => {
      events.blocked.push(result);
    },
  };
}

function startProxy(
  options: ConnectProxyOptions
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createConnectProxy(options);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

function stopProxy(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), 250);
    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

test("CONNECT to port 22 is refused with 403", async () => {
  const { events, onAllowed, onBlocked } = eventsCollector();
  const { server, port } = await startProxy({
    allowedHosts: ["127.0.0.1"],
    onAllowed,
    onBlocked,
  });
  try {
    const reply = await sendConnectRequest(port, "127.0.0.1:22");
    assert.equal(reply.status, 403);
    assert.ok(reply.body.includes("Blocked by egress policy"));
    assert.equal(events.allowed.length, 0);
    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].allowed, false);
    assert.equal(events.blocked[0].port, 22);
  } finally {
    await stopProxy(server);
  }
});

test("CONNECT to port 443 is allowed by the default ports", async () => {
  const options: ConnectProxyOptions = { allowedHosts: ["127.0.0.1"] };
  assert.equal(evaluateConnectTarget("127.0.0.1:443", options).allowed, true);
  assert.equal(evaluateConnectTarget("127.0.0.1:80", options).allowed, true);
  // No explicit port follows the tunnel default of 443.
  assert.equal(evaluateConnectTarget("127.0.0.1", options).allowed, true);

  const { events, onAllowed, onBlocked } = eventsCollector();
  const { server, port } = await startProxy({ ...options, onAllowed, onBlocked });
  try {
    const reply = await sendConnectRequest(port, "127.0.0.1:443");
    assert.notEqual(reply.status, 403);
    assert.equal(events.blocked.length, 0);
    assert.equal(events.allowed.length, 1);
    assert.deepEqual(events.allowed[0], { host: "127.0.0.1", port: 443 });
  } finally {
    await stopProxy(server);
  }
});

test("allowlist entry with ports [8443] allows 8443 and not 443", async () => {
  const options: ConnectProxyOptions = {
    allowedHosts: [{ host: "127.0.0.1", ports: [8443] }],
  };
  const accepted = evaluateConnectTarget("127.0.0.1:8443", options);
  assert.equal(accepted.allowed, true);
  const refused = evaluateConnectTarget("127.0.0.1:443", options);
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "BLOCKED_PORT");
  assert.equal(refused.port, 443);

  const { events, onAllowed, onBlocked } = eventsCollector();
  const { server, port } = await startProxy({ ...options, onAllowed, onBlocked });
  try {
    const tunnel = await sendConnectRequest(port, "127.0.0.1:8443");
    assert.notEqual(tunnel.status, 403);
    assert.equal(events.blocked.length, 0);
    assert.equal(events.allowed.length, 1);
    assert.deepEqual(events.allowed[0], { host: "127.0.0.1", port: 8443 });

    const blockedReply = await sendConnectRequest(port, "127.0.0.1:443");
    assert.equal(blockedReply.status, 403);
    assert.ok(blockedReply.body.includes("Blocked by egress policy"));
    assert.equal(events.allowed.length, 1);
    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].port, 443);
    assert.equal(events.blocked[0].code, "BLOCKED_PORT");
  } finally {
    await stopProxy(server);
  }
});

test("any other port is refused with 403", async () => {
  const options: ConnectProxyOptions = { allowedHosts: ["127.0.0.1"] };
  for (const p of [8080, 3128, 9200]) {
    const result = evaluateConnectTarget(`127.0.0.1:${p}`, options);
    assert.equal(result.allowed, false, `port ${p} must be refused`);
    assert.equal(result.code, "BLOCKED_PORT");
    assert.equal(result.port, p);
  }

  const { events, onAllowed, onBlocked } = eventsCollector();
  const { server, port } = await startProxy({ ...options, onAllowed, onBlocked });
  try {
    const reply = await sendConnectRequest(port, "127.0.0.1:8080");
    assert.equal(reply.status, 403);
    assert.ok(reply.body.includes("Blocked by egress policy"));
    assert.equal(events.allowed.length, 0);
    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].port, 8080);
  } finally {
    await stopProxy(server);
  }
});
