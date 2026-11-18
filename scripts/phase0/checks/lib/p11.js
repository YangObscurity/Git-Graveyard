// P11: which hosts does kiro-cli talk to, and does anything look like a token
// exchange? The design needs the host list for the skeleton UID's firewall
// allowlist (C11 NE-01, NE-02, NE-04).
//
// A local CONNECT proxy logs every host:port kiro-cli tunnels to during one real
// headless turn, then forwards the bytes so the turn can still succeed. TLS hides
// headers, so what the key header looks like is not observable; the probe says so.
// PASS: the turn finished through the proxy and at least one host was recorded.
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { finish } = require("./acp");

(async () => {
  const lines = [];
  const hosts = new Map();
  const proxy = http.createServer((req, res) => {
    lines.push("[PROXY plain-http] " + req.method + " " + req.url);
    hosts.set(String(req.headers.host || req.url), (hosts.get(String(req.headers.host || req.url)) || 0) + 1);
    res.writeHead(502);
    res.end();
  });
  proxy.on("connect", (req, clientSocket, head) => {
    const [h, p] = String(req.url).split(":");
    const key = h + ":" + (p || "443");
    hosts.set(key, (hosts.get(key) || 0) + 1);
    const upstream = net.connect(Number(p || 443), h, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + proxy.address().port;
  lines.push("logging CONNECT proxy at " + url);

  const out = await new Promise((resolve) => {
    const child = spawn(process.env.KIRO_BIN, ["chat", "--v3", "--no-interactive", "--output-format", "stream-json", "Reply with the single word ok."], {
      env: { ...process.env, HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, NO_PROXY: "", no_proxy: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let so = "";
    let se = "";
    child.stdout.on("data", (d) => (so += d));
    child.stderr.on("data", (d) => (se += d));
    const t = setTimeout(() => child.kill("SIGTERM"), 150000);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, so, se });
    });
  });
  proxy.close();
  const finished = /"type":"runFinished"[^\n]*"status":"success"/.test(out.so);
  const list = Array.from(hosts.entries()).sort((a, b) => b[1] - a[1]);
  lines.push("exit code: " + out.code + "; run finished with success through the proxy: " + finished);
  lines.push("hosts tunnelled (host:port count): " + (list.map(([h, n]) => h + " x" + n).join(", ") || "none"));
  lines.push("headers: not observable (TLS inside CONNECT); with cli-login there is no API key header to inspect");
  const auth = list.filter(([h]) => /oidc|sso|signin|auth|login|cognito/i.test(h)).map(([h]) => h);
  lines.push("hosts that look like auth/token endpoints: " + (auth.join(", ") || "none seen in this turn"));
  if (list.length === 0) {
    return finish(lines, "FAIL: kiro-cli did not use the HTTPS proxy for any connection (no CONNECT seen); the firewall allowlist cannot be derived by proxy and egress needs another control");
  }
  if (!finished) return finish(lines, "INCONCLUSIVE: hosts were recorded (" + list.map(([h]) => h).join(", ") + ") but the turn did not finish through the proxy");
  return finish(lines, "PASS: one headless turn finished through a CONNECT proxy; hosts needed: " + list.map(([h]) => h).join(", ") + "; key header not observable (TLS) and no API key exists under cli-login");
})().catch((e) => {
  console.log("FAIL: unexpected error in P11: " + e.message);
  process.exit(1);
});
