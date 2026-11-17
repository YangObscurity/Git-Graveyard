// RC4: Port restriction enforcement on plain HTTP forwarding (audit item N-C8).
// Plain HTTP forwarding must enforce port allowlist rules consistently with CONNECT:
// default ports [443, 80], entry.ports restrictions, 403 BLOCKED_PORT for blocked ports,
// 400 INVALID_TARGET for invalid/out-of-range ports.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import {
  createConnectProxy,
  isPrivateOrReservedIp,
  normalizeHost,
  evaluateHost,
  type ConnectProxyOptions,
  type HostEvaluationResult,
} from "../../lib/backend/connect-proxy";

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Rc4Events {
  allowed: Array<{ host: string; port?: number }>;
  blocked: HostEvaluationResult[];
  blockedRequests: Array<{ target: string; port: number; reason: string }>;
}

function eventsCollector(): {
  events: Rc4Events;
  onAllowed: ConnectProxyOptions["onAllowed"];
  onBlocked: ConnectProxyOptions["onBlocked"];
  onBlockedRequest: ConnectProxyOptions["onBlockedRequest"];
} {
  const events: Rc4Events = {
    allowed: [],
    blocked: [],
    blockedRequests: [],
  };
  return {
    events,
    onAllowed: (dest) => {
      events.allowed.push(dest);
    },
    onBlocked: (result) => {
      events.blocked.push(result);
    },
    onBlockedRequest: (target, port, reason) => {
      events.blockedRequests.push({ target, port, reason });
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

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), 250);
    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

function sendHttpProxyRequest(
  proxyPort: number,
  targetUrl: string,
  method = "GET"
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method,
        path: targetUrl,
        headers: {
          Host: parsed.host,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function sendRawRequest(
  proxyPort: number,
  raw: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    let responseText = "";
    socket.setTimeout(5000);
    socket.on("connect", () => {
      socket.write(raw);
    });
    socket.on("data", (chunk) => {
      responseText += chunk.toString("utf8");
    });
    socket.on("end", () => {
      socket.end();
    });
    socket.on("close", () => {
      const headerEnd = responseText.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return reject(new Error("No complete HTTP header received"));
      }
      const headerPart = responseText.slice(0, headerEnd);
      let body = responseText.slice(headerEnd + 4);
      const lines = headerPart.split("\r\n");
      const statusLine = lines[0];
      const status = parseInt(statusLine.split(" ")[1], 10);
      const headers: http.IncomingHttpHeaders = {};
      for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(":");
        if (colon !== -1) {
          const key = lines[i].slice(0, colon).trim().toLowerCase();
          const val = lines[i].slice(colon + 1).trim();
          headers[key] = val;
        }
      }
      if (headers["transfer-encoding"] === "chunked") {
        let dechunked = "";
        let remaining = body;
        while (remaining.length > 0) {
          const lineEnd = remaining.indexOf("\r\n");
          if (lineEnd === -1) break;
          const chunkSize = parseInt(remaining.slice(0, lineEnd), 16);
          if (isNaN(chunkSize) || chunkSize === 0) break;
          const chunkData = remaining.slice(lineEnd + 2, lineEnd + 2 + chunkSize);
          dechunked += chunkData;
          remaining = remaining.slice(lineEnd + 2 + chunkSize + 2);
        }
        body = dechunked;
      }
      resolve({ status, headers, body });
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Socket timed out waiting for proxy reply"));
    });
    socket.on("error", (err) => {
      reject(err);
    });
  });
}

function sendConnectRequest(
  proxyPort: number,
  target: string
): Promise<{ status: number; body: string }> {
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

test("plain HTTP request to allowlisted host on blocked port returns 403 BLOCKED_PORT without connecting upstream", async () => {
  let upstreamRequests = 0;
  const upstream = await startUpstream((_req, res) => {
    upstreamRequests++;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("upstream response");
  });

  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: ["127.0.0.1"],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendHttpProxyRequest(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/test-pkg`
    );

    assert.equal(res.status, 403);
    assert.equal(res.headers["content-type"], "application/json");

    const json = JSON.parse(res.body);
    assert.equal(json.code, "BLOCKED_PORT");
    assert.equal(json.host, "127.0.0.1");
    assert.ok(json.error);

    // Verify no upstream socket or connection was opened
    assert.equal(upstreamRequests, 0);

    // Verify callback events
    assert.equal(events.allowed.length, 0);
    assert.equal(events.blockedRequests.length, 1);
    assert.equal(events.blockedRequests[0].target, "127.0.0.1");
    assert.equal(events.blockedRequests[0].port, upstream.port);
    assert.equal(events.blockedRequests[0].reason, json.error);

    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].code, "BLOCKED_PORT");
    assert.equal(events.blocked[0].port, upstream.port);
  } finally {
    await stopServer(proxy.server);
    await stopServer(upstream.server);
  }
});

test("plain HTTP request to allowlisted host on port 22 returns 403 BLOCKED_PORT", async () => {
  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: ["127.0.0.1"],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendHttpProxyRequest(
      proxy.port,
      "http://127.0.0.1:22/ssh-probe"
    );

    assert.equal(res.status, 403);
    assert.equal(res.headers["content-type"], "application/json");

    const json = JSON.parse(res.body);
    assert.equal(json.code, "BLOCKED_PORT");
    assert.equal(json.host, "127.0.0.1");
    assert.ok(json.error);

    assert.equal(events.allowed.length, 0);
    assert.equal(events.blockedRequests.length, 1);
    assert.equal(events.blockedRequests[0].target, "127.0.0.1");
    assert.equal(events.blockedRequests[0].port, 22);
  } finally {
    await stopServer(proxy.server);
  }
});

test("plain HTTP request on explicitly permitted port in entry.ports succeeds", async () => {
  let upstreamCalled = false;
  const upstream = await startUpstream((req, res) => {
    upstreamCalled = true;
    assert.equal(req.url, "/hello?param=1");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello from permitted upstream");
  });

  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: [{ host: "127.0.0.1", ports: [upstream.port] }],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendHttpProxyRequest(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/hello?param=1`
    );

    assert.equal(res.status, 200);
    assert.equal(res.body, "hello from permitted upstream");
    assert.equal(upstreamCalled, true);

    assert.equal(events.allowed.length, 1);
    assert.deepEqual(events.allowed[0], { host: "127.0.0.1", port: upstream.port });
    assert.equal(events.blocked.length, 0);
    assert.equal(events.blockedRequests.length, 0);
  } finally {
    await stopServer(proxy.server);
    await stopServer(upstream.server);
  }
});

test("plain HTTP request to host with entry.ports restricts default port 80", async () => {
  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: [{ host: "127.0.0.1", ports: [8443] }],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendHttpProxyRequest(
      proxy.port,
      "http://127.0.0.1/restricted-80"
    );

    assert.equal(res.status, 403);
    const json = JSON.parse(res.body);
    assert.equal(json.code, "BLOCKED_PORT");
    assert.equal(json.host, "127.0.0.1");

    assert.equal(events.allowed.length, 0);
    assert.equal(events.blockedRequests.length, 1);
    assert.equal(events.blockedRequests[0].port, 80);
  } finally {
    await stopServer(proxy.server);
  }
});

test("plain HTTP request to allowlisted host on default port 80 is allowed by default policy", async () => {
  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: ["127.0.0.1"],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendHttpProxyRequest(
      proxy.port,
      "http://127.0.0.1/allowed-default-80"
    );

    // Port 80 is permitted, so proxy attempts upstream connection.
    // Since nothing is listening on port 80, upstream connection fails with 502 Bad Gateway.
    // It must NOT be rejected with 403 BLOCKED_PORT.
    assert.equal(res.status, 502);
    assert.equal(events.allowed.length, 1);
    assert.deepEqual(events.allowed[0], { host: "127.0.0.1", port: 80 });
    assert.equal(events.blockedRequests.length, 0);
  } finally {
    await stopServer(proxy.server);
  }
});

test("plain HTTP request with invalid or out-of-range port returns 400 INVALID_TARGET", async () => {
  const proxy = await startProxy({
    allowedHosts: ["127.0.0.1"],
  });

  try {
    // Port 70000 is out of range
    const resOver = await sendRawRequest(
      proxy.port,
      "GET http://127.0.0.1:70000/pkg HTTP/1.1\r\nHost: 127.0.0.1:70000\r\n\r\n"
    );
    assert.equal(resOver.status, 400);
    const jsonOver = JSON.parse(resOver.body);
    assert.equal(jsonOver.code, "INVALID_TARGET");

    // Port 0 is out of range
    const resZero = await sendRawRequest(
      proxy.port,
      "GET http://127.0.0.1:0/pkg HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n"
    );
    assert.equal(resZero.status, 400);
    const jsonZero = JSON.parse(resZero.body);
    assert.equal(jsonZero.code, "INVALID_TARGET");

    // Port non-numeric
    const resBad = await sendRawRequest(
      proxy.port,
      "GET http://127.0.0.1:notaport/pkg HTTP/1.1\r\nHost: 127.0.0.1:notaport\r\n\r\n"
    );
    assert.equal(resBad.status, 400);
    const jsonBad = JSON.parse(resBad.body);
    assert.equal(jsonBad.code, "INVALID_TARGET");
  } finally {
    await stopServer(proxy.server);
  }
});

test("plain HTTP request to allowlisted registry.npmjs.org on blocked port 8080 returns 403 BLOCKED_PORT", async () => {
  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: ["registry.npmjs.org"],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendHttpProxyRequest(
      proxy.port,
      "http://registry.npmjs.org:8080/pkg"
    );

    assert.equal(res.status, 403);
    assert.equal(res.headers["content-type"], "application/json");

    const json = JSON.parse(res.body);
    assert.equal(json.code, "BLOCKED_PORT");
    assert.equal(json.host, "registry.npmjs.org");
    assert.ok(json.error);

    assert.equal(events.allowed.length, 0);
    assert.equal(events.blockedRequests.length, 1);
    assert.equal(events.blockedRequests[0].target, "registry.npmjs.org");
    assert.equal(events.blockedRequests[0].port, 8080);
    assert.equal(events.blockedRequests[0].reason, json.error);

    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].code, "BLOCKED_PORT");
    assert.equal(events.blocked[0].port, 8080);
  } finally {
    await stopServer(proxy.server);
  }
});

test("plain HTTP request with relative path and Host header enforces port restrictions", async () => {
  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: ["127.0.0.1"],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendRawRequest(
      proxy.port,
      "GET /relative-pkg HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n"
    );

    assert.equal(res.status, 403);
    const json = JSON.parse(res.body);
    assert.equal(json.code, "BLOCKED_PORT");
    assert.equal(json.host, "127.0.0.1");

    assert.equal(events.blockedRequests.length, 1);
    assert.equal(events.blockedRequests[0].target, "127.0.0.1");
    assert.equal(events.blockedRequests[0].port, 8080);
  } finally {
    await stopServer(proxy.server);
  }
});

test("plain HTTP request to non-allowlisted host returns 403 text/plain egress policy", async () => {
  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: ["127.0.0.1"],
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const res = await sendRawRequest(
      proxy.port,
      "GET http://denied.example.com/test HTTP/1.1\r\nHost: denied.example.com\r\n\r\n"
    );

    assert.equal(res.status, 403);
    assert.ok(res.body.includes("Blocked by egress policy"));
    assert.equal(events.allowed.length, 0);
    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].code, "NOT_IN_ALLOWLIST");
    assert.equal(events.blockedRequests.length, 0);
  } finally {
    await stopServer(proxy.server);
  }
});

test("isPrivateOrReservedIp classifies IPv4, IPv6, and IPv4-mapped IPv6 correctly", () => {
  // IPv4 metadata
  assert.deepEqual(isPrivateOrReservedIp("169.254.169.254"), {
    blocked: true,
    isMetadata: true,
    isLoopback: false,
    reason: "Cloud metadata / link-local address (169.254.0.0/16)",
  });
  assert.equal(isPrivateOrReservedIp("169.254.1.1").isMetadata, true);
  assert.equal(isPrivateOrReservedIp("169.254.1.1").blocked, true);

  // IPv4 loopback
  assert.deepEqual(isPrivateOrReservedIp("127.0.0.1"), {
    blocked: true,
    isMetadata: false,
    isLoopback: true,
    reason: "Loopback address (127.0.0.0/8)",
  });
  assert.equal(isPrivateOrReservedIp("127.255.255.255").isLoopback, true);

  // IPv4 private and reserved ranges
  assert.equal(isPrivateOrReservedIp("0.0.0.0").blocked, true);
  assert.equal(isPrivateOrReservedIp("10.0.0.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("100.64.0.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("100.127.255.255").blocked, true);
  assert.equal(isPrivateOrReservedIp("172.16.0.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("172.31.255.255").blocked, true);
  assert.equal(isPrivateOrReservedIp("192.0.0.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("192.168.1.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("198.18.0.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("198.19.255.255").blocked, true);
  assert.equal(isPrivateOrReservedIp("224.0.0.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("240.0.0.1").blocked, true);

  // IPv4 public addresses
  assert.deepEqual(isPrivateOrReservedIp("8.8.8.8"), {
    blocked: false,
    isMetadata: false,
    isLoopback: false,
  });
  assert.deepEqual(isPrivateOrReservedIp("1.1.1.1"), {
    blocked: false,
    isMetadata: false,
    isLoopback: false,
  });

  // IPv6 metadata
  assert.deepEqual(isPrivateOrReservedIp("fd00:ec2::254"), {
    blocked: true,
    isMetadata: true,
    isLoopback: false,
    reason: "AWS EC2 metadata address (fd00:ec2::254)",
  });
  assert.deepEqual(isPrivateOrReservedIp("fe80::a9fe:a9fe"), {
    blocked: true,
    isMetadata: true,
    isLoopback: false,
    reason: "Cloud metadata address (fe80::a9fe:a9fe)",
  });

  // IPv6 loopback
  assert.deepEqual(isPrivateOrReservedIp("::1"), {
    blocked: true,
    isMetadata: false,
    isLoopback: true,
    reason: "IPv6 loopback address (::1)",
  });
  assert.equal(isPrivateOrReservedIp("[::1]").isLoopback, true);

  // IPv6 unspecified, link-local, ULA, multicast
  assert.equal(isPrivateOrReservedIp("::").blocked, true);
  assert.equal(isPrivateOrReservedIp("fe80::1").blocked, true);
  assert.equal(isPrivateOrReservedIp("fe80::1%eth0").blocked, true);
  assert.equal(isPrivateOrReservedIp("[fe80::1%eth0]").blocked, true);
  assert.equal(isPrivateOrReservedIp("fc00::1").blocked, true);
  assert.equal(isPrivateOrReservedIp("fd12:3456::1").blocked, true);
  assert.equal(isPrivateOrReservedIp("ff02::1").blocked, true);

  // IPv6 public address
  assert.deepEqual(isPrivateOrReservedIp("2607:f8b0:4005:805::200e"), {
    blocked: false,
    isMetadata: false,
    isLoopback: false,
  });

  // IPv4-mapped IPv6
  assert.deepEqual(isPrivateOrReservedIp("::ffff:127.0.0.1"), {
    blocked: true,
    isMetadata: false,
    isLoopback: true,
    reason: "Loopback address (127.0.0.0/8)",
  });
  assert.equal(isPrivateOrReservedIp("::ffff:7f00:1").isLoopback, true);
  assert.equal(isPrivateOrReservedIp("::ffff:169.254.169.254").isMetadata, true);
  assert.equal(isPrivateOrReservedIp("::ffff:a9fe:a9fe").isMetadata, true);
  assert.equal(isPrivateOrReservedIp("::ffff:10.0.0.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("::ffff:0a00:0001").blocked, true);
  assert.equal(isPrivateOrReservedIp("::ffff:192.168.1.1").blocked, true);
  assert.equal(isPrivateOrReservedIp("::ffff:c0a8:0101").blocked, true);
  assert.equal(isPrivateOrReservedIp("::ffff:8.8.8.8").blocked, false);
  assert.equal(isPrivateOrReservedIp("::ffff:0808:0808").blocked, false);
});

test("plain HTTP request to https:// URL returns 400 INVALID_TARGET", async () => {
  const proxy = await startProxy({
    allowedHosts: ["registry.npmjs.org"],
  });

  try {
    const res = await sendRawRequest(
      proxy.port,
      "GET https://registry.npmjs.org/package HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n"
    );

    assert.equal(res.status, 400);
    assert.equal(res.headers["content-type"], "application/json");

    const json = JSON.parse(res.body);
    assert.equal(json.code, "INVALID_TARGET");
    assert.equal(json.error, "HTTPS targets must use CONNECT tunnel");
  } finally {
    await stopServer(proxy.server);
  }
});

test("normalizeHost and evaluateHost cleanly reject host:443xyz port syntax", async () => {
  assert.deepEqual(normalizeHost("registry.npmjs.org:443xyz"), { host: "", port: NaN });
  assert.deepEqual(normalizeHost("[::1]:443xyz"), { host: "", port: NaN });
  assert.deepEqual(normalizeHost("example.com:notaport"), { host: "", port: NaN });

  const evalResult = evaluateHost("registry.npmjs.org:443xyz");
  assert.equal(evalResult.allowed, false);
  assert.equal(evalResult.code, "NOT_IN_ALLOWLIST");

  const proxy = await startProxy({
    allowedHosts: ["registry.npmjs.org"],
  });

  try {
    const connectReply = await sendConnectRequest(proxy.port, "registry.npmjs.org:443xyz");
    assert.equal(connectReply.status, 403);
    assert.ok(connectReply.body.includes("Blocked by egress policy"));

    const httpReply = await sendRawRequest(
      proxy.port,
      "GET http://registry.npmjs.org:443xyz/pkg HTTP/1.1\r\nHost: registry.npmjs.org:443xyz\r\n\r\n"
    );
    assert.equal(httpReply.status, 400);
    const json = JSON.parse(httpReply.body);
    assert.equal(json.code, "INVALID_TARGET");
  } finally {
    await stopServer(proxy.server);
  }
});

test("DNS rebinding to private/metadata IP is blocked via custom lookupFn", async () => {
  const { events, onAllowed, onBlocked, onBlockedRequest } = eventsCollector();

  const metadataLookup: ConnectProxyOptions["lookupFn"] = (
    _hostname,
    _opts,
    callback
  ) => {
    callback(null, [{ address: "169.254.169.254", family: 4 }]);
  };

  const proxy = await startProxy({
    allowedHosts: ["registry.npmjs.org"],
    lookupFn: metadataLookup,
    onAllowed,
    onBlocked,
    onBlockedRequest,
  });

  try {
    const connectRes = await sendConnectRequest(proxy.port, "registry.npmjs.org:443");
    assert.equal(connectRes.status, 403);
    assert.ok(connectRes.body.includes("Blocked by egress policy"));
    assert.equal(events.allowed.length, 0);
    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].code, "BLOCKED_METADATA");

    const httpRes = await sendHttpProxyRequest(
      proxy.port,
      "http://registry.npmjs.org/test"
    );
    assert.equal(httpRes.status, 403);
    assert.ok(httpRes.body.includes("Blocked by egress policy"));
    assert.equal(events.blocked.length, 2);
    assert.equal(events.blocked[1].code, "BLOCKED_METADATA");
    assert.equal(events.allowed.length, 0);
  } finally {
    await stopServer(proxy.server);
  }
});

test("DNS rebinding to private IP is blocked with BLOCKED_PRIVATE_IP", async () => {
  const { events, onAllowed, onBlocked } = eventsCollector();

  const privateIpLookup: ConnectProxyOptions["lookupFn"] = (
    _hostname,
    _opts,
    callback
  ) => {
    callback(null, [{ address: "10.0.0.1", family: 4 }]);
  };

  const proxy = await startProxy({
    allowedHosts: ["registry.npmjs.org"],
    lookupFn: privateIpLookup,
    onAllowed,
    onBlocked,
  });

  try {
    const connectRes = await sendConnectRequest(proxy.port, "registry.npmjs.org:443");
    assert.equal(connectRes.status, 403);
    assert.ok(connectRes.body.includes("Blocked by egress policy"));
    assert.equal(events.allowed.length, 0);
    assert.equal(events.blocked.length, 1);
    assert.equal(events.blocked[0].code, "BLOCKED_PRIVATE_IP");
  } finally {
    await stopServer(proxy.server);
  }
});

test("pinned lookup passes validated IP to upstream and allows connection when permitted", async () => {
  let upstreamCalled = false;
  const upstream = await startUpstream((_req, res) => {
    upstreamCalled = true;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello from pinned upstream");
  });

  let lookupCalls = 0;
  const customLookup: ConnectProxyOptions["lookupFn"] = (
    _hostname,
    _opts,
    callback
  ) => {
    lookupCalls++;
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  };

  const { events, onAllowed, onBlocked } = eventsCollector();
  const proxy = await startProxy({
    allowedHosts: [{ host: "registry.npmjs.org", ports: [upstream.port] }],
    allowPrivateIps: true,
    lookupFn: customLookup,
    onAllowed,
    onBlocked,
  });

  try {
    const res = await sendHttpProxyRequest(
      proxy.port,
      `http://registry.npmjs.org:${upstream.port}/package`
    );

    assert.equal(res.status, 200);
    assert.equal(res.body, "hello from pinned upstream");
    assert.equal(upstreamCalled, true);
    assert.ok(lookupCalls >= 1);
    assert.equal(events.allowed.length, 1);
    assert.equal(events.blocked.length, 0);
  } finally {
    await stopServer(proxy.server);
    await stopServer(upstream.server);
  }
});

test("pinned lookup is passed to net.connect for CONNECT tunnel", async () => {
  const rawUpstream = await new Promise<{ server: net.Server; port: number }>((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\n\r\nupstream-data");
      socket.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });

  let lookupCalls = 0;
  const customLookup: ConnectProxyOptions["lookupFn"] = (
    _hostname,
    _opts,
    callback
  ) => {
    lookupCalls++;
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  };

  const proxy = await startProxy({
    allowedHosts: [{ host: "github.com", ports: [rawUpstream.port] }],
    allowPrivateIps: true,
    lookupFn: customLookup,
  });

  try {
    const reply = await sendConnectRequest(proxy.port, `github.com:${rawUpstream.port}`);
    assert.equal(reply.status, 200);
    assert.ok(lookupCalls >= 1);
  } finally {
    await stopServer(proxy.server);
    await new Promise<void>((resolve) => rawUpstream.server.close(() => resolve()));
  }
});
