// P1: does `kiro-cli acp --agent-engine=v3` run a complete headless turn?
// PASS needs a finished prompt turn (stopReason end_turn) with an agent reply,
// not just a session id. The auth path is recorded: with no KIRO_API_KEY the run
// uses the kiro-cli login, and the API-key path stays unverified.
const { AcpSession, finish } = require("./acp");

(async () => {
  const lines = [];
  const auth = process.env.PHASE0_AUTH_PATH || "unknown";
  lines.push("P1: one complete headless ACP turn (auth path: " + auth + ")");
  const s = new AcpSession({ cwd: process.env.P1_WORK, clientName: "p1-probe" }).start();
  const note = () => lines.push(...s.lines);

  const init = await s.initialize();
  if (!init.result) {
    note();
    return finish(lines, "FAIL: initialize failed: " + JSON.stringify(init.error || init));
  }
  lines.push("authMethods advertised: " + JSON.stringify((init.result.authMethods || []).map((m) => m.id || m)));
  const ses = await s.newSession();
  if (!ses.result || !ses.result.sessionId) {
    note();
    await s.stop();
    return finish(lines, "FAIL: session/new failed: " + JSON.stringify(ses.error || ses));
  }
  const t0 = Date.now();
  const turn = await s.prompt(ses.result.sessionId, "Reply with the single word ok. Do not use any tool.", 120000);
  const ms = Date.now() - t0;
  await s.stop();
  note();
  const stop = turn.result && turn.result.stopReason;
  lines.push("turn: stopReason=" + stop + " latency=" + ms + " ms; agent text: " + JSON.stringify(s.agentText.slice(0, 80)));
  if (turn.timedOut) return finish(lines, "INCONCLUSIVE: the prompt turn did not finish within 120 s");
  if (stop === "end_turn" && s.agentText.trim().length > 0) {
    return finish(
      lines,
      "PASS: a complete headless turn finished (end_turn, " + ms + " ms) via " + auth +
        (auth === "api-key" ? "" : "; the KIRO_API_KEY path is unverified (no key can be issued)")
    );
  }
  return finish(lines, "FAIL: the turn did not complete cleanly: stopReason=" + stop + " error=" + JSON.stringify(turn.error || null));
})().catch((e) => {
  console.log("FAIL: unexpected error in P1: " + e.message);
  process.exit(1);
});
