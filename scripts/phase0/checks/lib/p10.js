// P10: can a run container reach a Kiro host only through an injected proxy?
// A logging CONNECT proxy listens on the box. Three containers run curl against a
// Kiro host found by P11:
//   proxied   HTTPS_PROXY pointing at the box proxy  -> must get an HTTP status and
//             the proxy must log the CONNECT coming from the container;
//   no proxy  --network none                         -> must NOT connect (control:
//             a container with no route cannot reach the host by itself);
//   wrong host the proxied container asking for a host the proxy refuses -> must
//             fail (control: the proxy is the enforcement point).
// PASS needs the proxied container to connect through the proxy and both controls
// to fail.
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { finish } = require("./acp");

const TARGET = process.env.P10_HOST || "runtime.us-east-1.kiro.dev";
const ALLOWED = new Set([TARGET + ":443"]);
const IMAGE = process.env.P10_IMAGE || "curlimages/curl:latest";

(async () => {
  const lines = [];
  const seen = [];
  const refused = [];
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on("connect", (req, clientSocket, head) => {
    const key = String(req.url);
    seen.push(key + " from " + clientSocket.remoteAddress);
    if (!ALLOWED.has(key)) {
      refused.push(key);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return clientSocket.destroy();
    }
    const [h, p] = key.split(":");
    const up = net.connect(Number(p), h, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, "0.0.0.0", r));
  const port = proxy.address().port;
  lines.push("allow-list proxy on 0.0.0.0:" + port + " allowing only " + Array.from(ALLOWED).join(","));

  // Async on purpose: spawnSync would block the event loop that serves the proxy.
  const docker = (args, timeout) =>
    new Promise((resolve) => {
      const c = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      const t = setTimeout(() => c.kill("SIGKILL"), timeout || 120000);
      c.on("close", (status) => {
        clearTimeout(t);
        resolve({ status, stdout, stderr });
      });
    });
  const probe = await docker(["version", "--format", "{{.Server.Version}}"], 20000);
  if (probe.status !== 0) {
    proxy.close();
    return finish(lines, "INCONCLUSIVE: docker is not usable on this box: " + String(probe.stderr).slice(0, 160));
  }
  lines.push("docker server " + probe.stdout.trim());
  const pull = await docker(["pull", IMAGE], 180000);
  lines.push("pull " + IMAGE + ": exit " + pull.status);

  const curl = async (extra, env, url) => {
    const args = ["run", "--rm", "--add-host=host.docker.internal:host-gateway", ...extra];
    for (const [k, v] of Object.entries(env)) args.push("-e", k + "=" + v);
    args.push(IMAGE, "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "30", url);
    const r = await docker(args, 90000);
    return { code: (r.stdout || "").trim(), err: String(r.stderr || "").trim().slice(0, 160), status: r.status };
  };
  const px = "http://host.docker.internal:" + port;
  const proxied = await curl([], { HTTPS_PROXY: px, https_proxy: px }, "https://" + TARGET + "/");
  const proxiedSeen = seen.some((s) => s.startsWith(TARGET + ":443"));
  const noNet = await curl(["--network", "none"], {}, "https://" + TARGET + "/");
  const wrong = await curl([], { HTTPS_PROXY: px, https_proxy: px }, "https://example.com/");
  proxy.close();
  const connected = (r) => /^\d{3}$/.test(r.code) && r.code !== "000";
  lines.push("proxied container -> https://" + TARGET + ": http_code=" + proxied.code + " (curl exit " + proxied.status + ") " + proxied.err);
  lines.push("proxy saw CONNECT for the target from a container: " + proxiedSeen + "; all CONNECTs: " + seen.join("; "));
  lines.push("control --network none: http_code=" + noNet.code + " " + noNet.err);
  lines.push("control host the proxy refuses (example.com): http_code=" + wrong.code + " refused by proxy: " + refused.includes("example.com:443") + " " + wrong.err);

  if (!connected(proxied) || !proxiedSeen) {
    return finish(lines, "FAIL: a container could not reach " + TARGET + " through the injected proxy (http_code " + proxied.code + ", proxy saw it: " + proxiedSeen + ")");
  }
  if (connected(noNet)) return finish(lines, "FAIL: the --network none control reached the host, so the isolation control is broken");
  if (connected(wrong)) return finish(lines, "FAIL: the proxy did not stop a host outside its allow-list");
  return finish(lines, "PASS: a container reached " + TARGET + " (HTTP " + proxied.code + ") only through the injected proxy; --network none and a non-allow-listed host both failed");
})().catch((e) => {
  console.log("FAIL: unexpected error in P10: " + e.message);
  process.exit(1);
});
