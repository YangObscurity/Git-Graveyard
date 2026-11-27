// Task 21.3: Tier 3 hard blocks (command argv, budget ceilings, candidate diffs).
// Validates: Requirements 27.13, 27.14, 27.15, 29.10, 29.11, 29.12, 29.13.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCommandHardBlocks,
  checkBudgetIncreaseHardBlocks,
  validateCandidateDiff,
  assertNoHardBlock,
  isProtectedPath,
  normalizeCandidatePath,
  parseDiffPaths,
  PROTECTED_DIRECTORIES,
  PRIVILEGE_COMMAND_HEADS,
  SUDO_BINARIES,
  PRIVILEGE_ESCALATION_BINARIES,
  DESTRUCTIVE_HOST_BINARIES,
  CONTAINER_SOCKET_MARKERS,
  isHostBindVolumeMount,
} from "../../lib/policy/hard-blocks";

test("checkCommandHardBlocks: blocks sudo and raw privilege escalation", () => {
  for (const argv of [
    ["sudo", "apt-get", "install", "curl"],
    ["/usr/bin/sudo", "ls"],
    ["doas", "sh"],
    ["su", "-", "root"],
    ["pkexec", "sh", "-c", "id"],
    ["sudoedit", "/etc/hosts"],
  ]) {
    const result = checkCommandHardBlocks(argv);
    assert.equal(result.blocked, true, `${argv.join(" ")} must be blocked`);
    assert.ok(result.code === "HARD_BLOCK_SUDO", `expected sudo code for ${argv.join(" ")}`);
    assert.ok(typeof result.reason === "string");
  }

  const setcap = checkCommandHardBlocks(["setcap", "cap_sys_admin+ep", "/tmp/x"]);
  assert.equal(setcap.blocked, true);
  assert.equal(setcap.code, "HARD_BLOCK_PRIVILEGE_ESCALATION");
});

test("checkCommandHardBlocks: blocks container runtime sockets", () => {
  const cases: Array<[string[], string]> = [
    [["docker", "run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "img"], "docker.sock"],
    [["curl", "--unix-socket", "/run/podman/podman.sock", "http://x"], "podman.sock"],
    [["ctr", "--address", "/run/containerd/containerd.sock", "images"], "containerd.sock"],
  ];
  for (const [argv, marker] of cases) {
    const result = checkCommandHardBlocks(argv);
    assert.equal(result.blocked, true, `${argv.join(" ")} must be blocked`);
    assert.ok(result.reason?.includes(marker), `reason should name ${marker}`);
    assert.equal(result.code, "HARD_BLOCK_CONTAINER_SOCKET");
  }
});

test("checkCommandHardBlocks: blocks host mounts and host namespaces", () => {
  for (const argv of [
    ["docker", "run", "--privileged", "img"],
    ["docker", "run", "--pid=host", "img"],
    ["docker", "run", "--mount", "type=bind,source=/etc,target=/etc", "img"],
    ["docker", "run", "-v", "/:/host", "img"],
    ["docker", "run", "--volume=/etc:/etc", "img"],
  ]) {
    const result = checkCommandHardBlocks(argv);
    assert.equal(result.blocked, true, `${argv.join(" ")} must be blocked`);
    assert.equal(result.code, "HARD_BLOCK_HOST_MOUNT");
  }
});

test("checkCommandHardBlocks: blocks destructive host operations", () => {
  for (const argv of [
    ["mkfs.ext4", "/dev/sda1"],
    ["shutdown", "-h", "now"],
    ["rm", "-rf", "/"],
    ["rm", "-fr", "/etc"],
    ["dd", "if=/dev/zero", "of=/dev/sda"],
  ]) {
    const result = checkCommandHardBlocks(argv);
    assert.equal(result.blocked, true, `${argv.join(" ")} must be blocked`);
    assert.equal(result.code, "HARD_BLOCK_DESTRUCTIVE_HOST_OP");
  }

  // A scoped rm inside a worktree is not a hard block.
  assert.equal(checkCommandHardBlocks(["rm", "-rf", "node_modules"]).blocked, false);
});

test("checkCommandHardBlocks: allows benign commands and rejects malformed argv", () => {
  for (const argv of [
    ["git", "status"],
    ["npm", "run", "build"],
    ["pytest", "-q"],
    ["ls", "-la"],
  ]) {
    assert.equal(checkCommandHardBlocks(argv).blocked, false, argv.join(" "));
  }

  const empty = checkCommandHardBlocks([]);
  assert.equal(empty.blocked, true);
  assert.equal(empty.code, "HARD_BLOCK_INVALID_ARGV");

  const bad = checkCommandHardBlocks(["git", 42 as unknown as string]);
  assert.equal(bad.blocked, true);
  assert.equal(bad.code, "HARD_BLOCK_INVALID_ARGV");
});

test("checkBudgetIncreaseHardBlocks: refuses only ceiling-breaking increases", () => {
  // Within the ceiling: allowed.
  assert.equal(
    checkBudgetIncreaseHardBlocks({
      currentCap: 10,
      requestedCap: 20,
      codeCeiling: 50,
      globalCeiling: 100,
    }).blocked,
    false
  );

  // Above the code ceiling: refused.
  const above = checkBudgetIncreaseHardBlocks({
    currentCap: 10,
    requestedCap: 80,
    codeCeiling: 50,
    globalCeiling: 100,
  });
  assert.equal(above.blocked, true);
  assert.equal(above.code, "HARD_BLOCK_BUDGET_CEILING");

  // Above the global ceiling even when under the code ceiling: refused.
  assert.equal(
    checkBudgetIncreaseHardBlocks({
      currentCap: 10,
      requestedCap: 75,
      codeCeiling: 100,
      globalCeiling: 60,
    }).blocked,
    true
  );

  // No ceiling configured: any increase refused.
  assert.equal(
    checkBudgetIncreaseHardBlocks({ currentCap: 10, requestedCap: 11 }).blocked,
    true
  );

  // Reductions are never blocked.
  assert.equal(
    checkBudgetIncreaseHardBlocks({ currentCap: 10, requestedCap: 5, codeCeiling: 5 }).blocked,
    false
  );

  // Non-finite values are refused.
  assert.equal(
    checkBudgetIncreaseHardBlocks({ currentCap: 10, requestedCap: NaN }).code,
    "HARD_BLOCK_INVALID_BUDGET"
  );
});

test("validateCandidateDiff: rejects any .kiro/ or .git/ modification", () => {
  assert.deepEqual([...PROTECTED_DIRECTORIES], [".kiro", ".git"]);

  const steeringDiff = [
    "diff --git a/.kiro/steering/tech.md b/.kiro/steering/tech.md",
    "index 111..222 100644",
    "--- a/.kiro/steering/tech.md",
    "+++ b/.kiro/steering/tech.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const steering = validateCandidateDiff(steeringDiff);
  assert.equal(steering.blocked, true);
  assert.equal(steering.code, "HARD_BLOCK_PROTECTED_PATH");
  assert.ok(steering.reason?.includes(".kiro/"));
  assert.ok((steering.details?.offenders as string[]).includes(".kiro/steering/tech.md"));

  const gitConfig = validateCandidateDiff({ files: ["src/index.ts", ".git/config"] });
  assert.equal(gitConfig.blocked, true);
  assert.equal(gitConfig.code, "HARD_BLOCK_PROTECTED_PATH");

  // Nested protected directory.
  assert.equal(validateCandidateDiff(["app/.git/hooks/pre-commit"]).blocked, true);

  // Rename into a protected directory.
  assert.equal(
    validateCandidateDiff({ diff: "rename to .kiro/specs/x/tasks.md" }).blocked,
    true
  );

  // Benign diffs pass.
  const benign = validateCandidateDiff({
    files: ["src/app.ts", "test/app.test.ts"],
    diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n",
  });
  assert.equal(benign.blocked, false);
});

test("path helpers: normalizeCandidatePath, isProtectedPath, parseDiffPaths", () => {
  assert.equal(normalizeCandidatePath("b/.kiro/steering/x.md"), ".kiro/steering/x.md");
  assert.equal(normalizeCandidatePath('"a/.git/config"'), ".git/config");
  assert.equal(normalizeCandidatePath("./src/x"), "src/x");
  assert.equal(normalizeCandidatePath(""), null);

  assert.equal(isProtectedPath(".kiro"), true);
  assert.equal(isProtectedPath(".git/"), true);
  assert.equal(isProtectedPath("src/.git/config"), true);
  assert.equal(isProtectedPath("lib/git/git-service.ts"), false);

  const paths = parseDiffPaths(
    [
      "diff --git a/one.txt b/one.txt",
      "--- a/two.txt",
      "+++ b/three.txt",
      "rename from four.txt",
      "rename to five.txt",
    ].join("\n")
  );
  assert.deepEqual(
    paths.sort(),
    ["five.txt", "four.txt", "one.txt", "three.txt", "two.txt"].sort()
  );
});

test("assertNoHardBlock: throws the structured denial and lifts nothing", () => {
  assert.doesNotThrow(() => assertNoHardBlock({ blocked: false }));
  assert.throws(
    () => assertNoHardBlock(checkCommandHardBlocks(["sudo", "ls"])),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error & { code?: string }).code, "HARD_BLOCK_SUDO");
      const hard = (err as Error & { hardBlock?: { blocked: boolean } }).hardBlock;
      assert.equal(hard?.blocked, true);
      return true;
    }
  );
});


test("checkCommandHardBlocks: shared Tier 3 constants are exported and consistent", () => {
  for (const bin of ["sudo", "sudoedit", "doas", "su", "pkexec"]) {
    assert.equal(SUDO_BINARIES.has(bin), true);
    assert.equal(PRIVILEGE_COMMAND_HEADS.has(bin), true);
  }
  for (const bin of ["setcap", "setuid", "chsh"]) {
    assert.equal(PRIVILEGE_ESCALATION_BINARIES.has(bin), true);
    assert.equal(PRIVILEGE_COMMAND_HEADS.has(bin), true);
  }
  for (const bin of ["mkfs", "mkfs.ext4", "shutdown", "reboot"]) {
    assert.equal(DESTRUCTIVE_HOST_BINARIES.has(bin), true);
  }
  assert.deepEqual([...CONTAINER_SOCKET_MARKERS], [
    "docker.sock",
    "podman.sock",
    "containerd.sock",
    "crio.sock",
  ]);
});

test("checkCommandHardBlocks: unwraps env/timeout/nohup and shell -c wrappers", () => {
  const blocked: Array<[string[], string]> = [
    [["env", "sudo", "id"], "HARD_BLOCK_SUDO"],
    [["env", "su"], "HARD_BLOCK_SUDO"],
    [["command", "sudo", "id"], "HARD_BLOCK_SUDO"],
    [["exec", "sudo", "id"], "HARD_BLOCK_SUDO"],
    [["timeout", "5", "sudo", "id"], "HARD_BLOCK_SUDO"],
    [["nice", "-n", "5", "setcap", "cap_sys_admin+ep", "/tmp/x"], "HARD_BLOCK_PRIVILEGE_ESCALATION"],
    [["nohup", "sudo", "id"], "HARD_BLOCK_SUDO"],
    [["time", "sudo", "id"], "HARD_BLOCK_SUDO"],
    [["sh", "-c", "sudo rm -rf /"], "HARD_BLOCK_SUDO"],
    [["bash", "-c", "sudo id"], "HARD_BLOCK_SUDO"],
    [["sh", "-c", "cat ok; sudo id"], "HARD_BLOCK_SUDO"],
    [["python3", "-c", "os.system('sudo id')"], "HARD_BLOCK_SUDO"],
    [["node", "-e", "require('child_process').execSync('sudo id')"], "HARD_BLOCK_SUDO"],
  ];
  for (const [argv, code] of blocked) {
    const result = checkCommandHardBlocks(argv);
    assert.equal(result.blocked, true, `${argv.join(" ")} must be blocked`);
    assert.equal(result.code, code, `${argv.join(" ")} expected ${code}`);
  }
});

test("checkCommandHardBlocks: sudo/privesc only at a command head position", () => {
  // A filename argument that merely basenames to a privileged binary is fine.
  assert.equal(checkCommandHardBlocks(["cat", "docs/su"]).blocked, false);
  assert.equal(checkCommandHardBlocks(["ls", "-l", "bin/sudo"]).blocked, false);

  // Real heads in any wrapped form are blocked.
  for (const argv of [
    ["su", "-"],
    ["/usr/bin/sudo", "id"],
    ["sh", "-c", "sudo id"],
    ["env", "su"],
  ]) {
    const result = checkCommandHardBlocks(argv);
    assert.equal(result.blocked, true, `${argv.join(" ")} must be blocked`);
  }
});

test("checkCommandHardBlocks: -v/--volume host bind mounts require a host:container colon pair", () => {
  // Bare paths (pytest -v /tests, grep -v /etc) are NOT host mounts.
  assert.equal(checkCommandHardBlocks(["pytest", "-v", "/tests"]).blocked, false);
  assert.equal(checkCommandHardBlocks(["grep", "-v", "/etc"]).blocked, false);

  assert.equal(isHostBindVolumeMount(["pytest", "-v", "/tests"]), false);
  assert.equal(isHostBindVolumeMount(["-v", "/:/host"]), true);
  assert.equal(isHostBindVolumeMount(["--volume=/etc:/mnt"]), true);

  for (const argv of [
    ["docker", "run", "-v", "/:/host", "alpine"],
    ["podman", "run", "--volume=/etc:/mnt", "img"],
    ["docker", "run", "-v", "./local:/container", "img"],
    ["docker", "run", "-v", "~/data:/container", "img"],
  ]) {
    const result = checkCommandHardBlocks(argv);
    assert.equal(result.blocked, true, `${argv.join(" ")} must be blocked`);
    assert.equal(result.code, "HARD_BLOCK_HOST_MOUNT");
  }
});

test("checkCommandHardBlocks: dd blocks only the output operand", () => {
  // Reading from a raw device is not a destructive write.
  assert.equal(checkCommandHardBlocks(["dd", "if=/dev/sda", "of=/tmp/disk.img"]).blocked, false);
  assert.equal(checkCommandHardBlocks(["dd", "if=/dev/zero", "of=/dev/sda"]).blocked, true);
  assert.equal(checkCommandHardBlocks(["dd", "of=/dev/nvme0n1"]).blocked, true);
  assert.equal(checkCommandHardBlocks(["dd", "of=/dev/mmcblk0"]).blocked, true);
  assert.equal(checkCommandHardBlocks(["dd", "if=/dev/sda", "of=backup.img"]).blocked, false);
});

test("parseDiffPaths: deleted lines inside a hunk body are never read as file paths", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,4 +1,4 @@",
    "-removed line",
    "--- a/not-a-real-header.txt",
    "-- a double dash content line",
    "+added line",
    "diff --git a/src/next.ts b/src/next.ts",
    "--- a/src/next.ts",
    "+++ b/src/next.ts",
  ].join("\n");

  const paths = parseDiffPaths(diff);
  assert.ok(paths.includes("src/app.ts"));
  assert.ok(paths.includes("src/next.ts"));
  assert.equal(
    paths.some((p) => p.includes("not-a-real-header")),
    false,
    "hunk-body content must never be interpreted as a file path"
  );
  assert.equal(
    paths.some((p) => p.includes("double dash")),
    false,
    "hunk-body content must never be interpreted as a file path"
  );

  // A deleted line that resembles a header only after the first hunk is ignored.
  const intoProtected = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "--- a/.kiro/steering/tech.md",
  ].join("\n");
  assert.equal(parseDiffPaths(intoProtected).includes(".kiro/steering/tech.md"), false);
});

