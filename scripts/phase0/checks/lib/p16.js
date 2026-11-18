// P16: Docker Engine API, non-pty exec/attach framing. Does the multiplexed stream
// keep stdout and stderr apart, rejoin lines that straddle frame boundaries, and
// lose nothing under load? The probe talks to the daemon socket directly, which is
// exactly the framing an SDK has to demux, and checks:
//   - stdout carries only the N numbered stdout lines, in order, none missing,
//   - stderr carries only the M stderr lines, in order,
//   - long lines (64 KiB, larger than a frame) survive intact,
//   - the frame stream ends cleanly and the container exit code is 0.
// "Lossless resume" (re-attach after a drop) is a separate question and is
// reported as not exercised here.
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const { finish } = require("./acp");

const SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const IMAGE = process.env.P16_IMAGE || "alpine:latest";
const N_OUT = 20000;
const N_ERR = 500;
const LONG = 65536;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ socketPath: SOCK, method, path, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function attach(id) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK);
    let buf = Buffer.alloc(0);
    let headerDone = false;
    const frames = [];
    let malformed = 0;
    sock.on("connect", () => {
      sock.write(
        "POST /containers/" + id + "/attach?stream=1&stdout=1&stderr=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n"
      );
      resolve({ sock, frames, done: new Promise((r) => sock.on("close", () => r({ malformed, leftover: buf.length }))) });
    });
    sock.on("error", reject);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headerDone) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        headerDone = true;
        buf = buf.subarray(i + 4);
      }
      while (buf.length >= 8) {
        const type = buf[0];
        const size = buf.readUInt32BE(4);
        if (type > 2 || buf[1] || buf[2] || buf[3]) { malformed++; buf = Buffer.alloc(0); return; }
        if (buf.length < 8 + size) return;
        frames.push({ type, payload: buf.subarray(8, 8 + size) });
        buf = buf.subarray(8 + size);
      }
    });
  });
}

(async () => {
  const lines = [];
  if (!fs.existsSync(SOCK)) return finish(lines, "INCONCLUSIVE: no Docker socket at " + SOCK);
  let v;
  try { v = await api("GET", "/version"); } catch (e) { return finish(lines, "INCONCLUSIVE: cannot reach the Docker daemon: " + e.message); }
  lines.push("docker version: " + (v.status === 200 ? JSON.parse(v.body).Version : "HTTP " + v.status));
  if (v.status !== 200) return finish(lines, "INCONCLUSIVE: the Docker daemon answered HTTP " + v.status);

  const inspect = await api("GET", "/images/" + encodeURIComponent(IMAGE) + "/json");
  if (inspect.status === 404) {
    const [name, tag] = IMAGE.split(":");
    const pull = await api("POST", "/images/create?fromImage=" + encodeURIComponent(name) + "&tag=" + encodeURIComponent(tag || "latest"));
    lines.push("pulled " + IMAGE + ": HTTP " + pull.status);
  }

  // Interleave stdout and stderr, with one stdout line larger than any frame.
  const script =
    'i=0; while [ $i -lt ' + N_OUT + ' ]; do echo "out-$i"; if [ $((i % 40)) -eq 0 ]; then echo "err-$((i / 40))" >&2; fi; i=$((i+1)); done; ' +
    'head -c ' + LONG + ' /dev/zero | tr "\\0" "x"; echo; echo "END" >&2';
  const created = await api("POST", "/containers/create", { Image: IMAGE, Cmd: ["sh", "-c", script], Tty: false, AttachStdout: true, AttachStderr: true, HostConfig: { AutoRemove: false } });
  if (created.status !== 201) return finish(lines, "INCONCLUSIVE: could not create the container: " + created.body.slice(0, 200));
  const id = JSON.parse(created.body).Id;
  try {
    const att = await attach(id);
    await new Promise((r) => setTimeout(r, 200));
    const started = await api("POST", "/containers/" + id + "/start");
    if (started.status !== 204) return finish(lines, "INCONCLUSIVE: could not start the container: " + started.body.slice(0, 200));
    const end = await Promise.race([att.done, new Promise((r) => setTimeout(() => r({ timeout: true }), 120000))]);
    const wait = await api("POST", "/containers/" + id + "/wait");
    const exit = wait.status === 200 ? JSON.parse(wait.body).StatusCode : null;

    const out = Buffer.concat(att.frames.filter((f) => f.type === 1).map((f) => f.payload)).toString("utf8");
    const err = Buffer.concat(att.frames.filter((f) => f.type === 2).map((f) => f.payload)).toString("utf8");
    const outLines = out.split("\n");
    const errLines = err.split("\n");
    if (outLines[outLines.length - 1] === "") outLines.pop();
    if (errLines[errLines.length - 1] === "") errLines.pop();
    const numbered = outLines.filter((l) => /^out-\d+$/.test(l));
    const longLine = outLines.find((l) => l.length === LONG && /^x+$/.test(l));
    let inOrder = numbered.length === N_OUT;
    for (let i = 0; inOrder && i < numbered.length; i++) if (numbered[i] !== "out-" + i) inOrder = false;
    const errNumbered = errLines.filter((l) => /^err-\d+$/.test(l));
    const errOrder = errNumbered.length === N_ERR && errNumbered.every((l, i) => l === "err-" + i);
    const stderrClean = errLines.every((l) => /^err-\d+$/.test(l) || l === "END");
    const stdoutClean = outLines.every((l) => /^out-\d+$/.test(l) || (l.length === LONG && /^x+$/.test(l)));
    const sizes = att.frames.map((f) => f.payload.length);
    lines.push("frames: " + att.frames.length + " (stdout " + att.frames.filter((f) => f.type === 1).length + ", stderr " + att.frames.filter((f) => f.type === 2).length + "), max frame " + Math.max(...sizes) + " bytes, malformed " + (end.malformed || 0));
    lines.push("stdout numbered lines: " + numbered.length + "/" + N_OUT + " in order: " + inOrder + "; long line intact: " + !!longLine + "; stdout clean: " + stdoutClean);
    lines.push("stderr numbered lines: " + errNumbered.length + "/" + N_ERR + " in order: " + errOrder + "; stderr clean: " + stderrClean + "; END seen: " + errLines.includes("END"));
    lines.push("exit code: " + exit + "; stream closed: " + !end.timeout);
    lines.push("lossless resume (re-attach after a drop): not exercised");
    const good = inOrder && !!longLine && stdoutClean && errOrder && stderrClean && errLines.includes("END") && exit === 0 && !end.timeout && !end.malformed;
    if (good) return finish(lines, "PASS: non-pty framing keeps stdout and stderr apart and lossless (" + N_OUT + " + " + N_ERR + " lines, a " + LONG + "-byte line, " + att.frames.length + " frames); resume not exercised");
    return finish(lines, "FAIL: Docker non-pty framing lost, mixed or reordered data (see the counts above); fall back to separateStderr: false");
  } finally {
    try { await api("DELETE", "/containers/" + id + "?force=1"); } catch (_) {}
  }
})().catch((e) => {
  console.log("FAIL: unexpected error in P16: " + e.message);
  process.exit(1);
});
