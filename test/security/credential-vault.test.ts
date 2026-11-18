// Unit tests for lib/security/credential-vault.ts
// Requirements: 42.7, 42.8, 42.9, 42.10, 42.11, 42.12, 42.13, 42.14, 42.15, 42.17, 42.19, 42.20

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SECRET_PLACEMENT_POLICIES,
  getSecretPlacementPolicy,
  isLocationAllowed,
  validateDistinctEnvironmentKeys,
  validateKiroKeyStorage,
  validateDockerPatStorage,
  validateInstaboxKeyStorage,
  validateGitServiceTokenHold,
  validateBoxEnvironment,
  validateBoxFiles,
  validateSkeletonEnvironment,
  validateStoredEvent,
  validateCommandLog,
  validateArtifacts,
  validateRepositoryContent,
  validateDocumentation,
  validateUiBundle,
  validateLiveRunEligibility,
  createPublicationRequest,
  adminReviewRun,
  adminRedactRun,
  validateRunForPublication,
  publishRun,
  CredentialVault,
  createCredentialVault,
  type SecretInventory,
  type RunPublicationRecord,
} from "../../lib/security/credential-vault";

describe("credential-vault: secret placement policies and location checks", () => {
  it("defines policies for all required secret kinds", () => {
    assert.ok(SECRET_PLACEMENT_POLICIES.kiro_api_key);
    assert.ok(SECRET_PLACEMENT_POLICIES.instabox_api_key);
    assert.ok(SECRET_PLACEMENT_POLICIES.github_token);
    assert.ok(SECRET_PLACEMENT_POLICIES.docker_pat);
    assert.ok(SECRET_PLACEMENT_POLICIES.admin_secret);
    assert.ok(SECRET_PLACEMENT_POLICIES.dev_box_ssh_address);
  });

  it("checks Kiro API key placement in development and production (Requirement 42.7)", () => {
    // Development allows necro secret file, memory, kiro-cli child env
    assert.equal(isLocationAllowed("kiro_api_key", "necro_secret_file", "development"), true);
    assert.equal(isLocationAllowed("kiro_api_key", "necromancer_memory", "development"), true);
    assert.equal(isLocationAllowed("kiro_api_key", "kiro_cli_child_env", "development"), true);
    assert.equal(isLocationAllowed("kiro_api_key", "box_environment", "development"), false);
    assert.equal(isLocationAllowed("kiro_api_key", "box_file", "development"), false);
    assert.equal(isLocationAllowed("kiro_api_key", "repository", "development"), false);

    // Production allows host secret store, memory, kiro-cli child env
    assert.equal(isLocationAllowed("kiro_api_key", "host_secret_store", "production"), true);
    assert.equal(isLocationAllowed("kiro_api_key", "necromancer_memory", "production"), true);
    assert.equal(isLocationAllowed("kiro_api_key", "kiro_cli_child_env", "production"), true);
    assert.equal(isLocationAllowed("kiro_api_key", "necro_secret_file", "production"), false);
    assert.equal(isLocationAllowed("kiro_api_key", "box_environment", "production"), false);
  });

  it("checks Instabox API key placement (Requirements 42.17, 42.20)", () => {
    assert.equal(isLocationAllowed("instabox_api_key", "owner_local_machine"), true);
    assert.equal(isLocationAllowed("instabox_api_key", "box_environment"), false);
    assert.equal(isLocationAllowed("instabox_api_key", "box_file"), false);
    assert.equal(isLocationAllowed("instabox_api_key", "repository"), false);
    assert.equal(isLocationAllowed("instabox_api_key", "dev_box"), false);
  });

  it("checks GitHub token placement (Requirements 42.10, 42.19)", () => {
    assert.equal(isLocationAllowed("github_token", "git_service"), true);
    assert.equal(isLocationAllowed("github_token", "skeleton_env"), false);
    assert.equal(isLocationAllowed("github_token", "box_environment"), false);
    assert.equal(isLocationAllowed("github_token", "command_log"), false);
  });

  it("checks Docker PAT placement (Requirement 42.11)", () => {
    assert.equal(isLocationAllowed("docker_pat", "host_secret_store"), true);
    assert.equal(isLocationAllowed("docker_pat", "dev_box"), false);
    assert.equal(isLocationAllowed("docker_pat", "box_environment"), false);
  });

  it("checks Admin secret placement (Requirement 42.12)", () => {
    assert.equal(isLocationAllowed("admin_secret", "server_config"), true);
    assert.equal(isLocationAllowed("admin_secret", "ui_bundle"), false);
    assert.equal(isLocationAllowed("admin_secret", "command_log"), false);
  });

  it("checks Dev box SSH address placement (Requirement 42.13)", () => {
    assert.equal(isLocationAllowed("dev_box_ssh_address", "host_ssh_config"), true);
    assert.equal(isLocationAllowed("dev_box_ssh_address", "repository"), false);
    assert.equal(isLocationAllowed("dev_box_ssh_address", "documentation"), false);
    assert.equal(isLocationAllowed("dev_box_ssh_address", "stored_event"), false);
  });
});

describe("credential-vault: distinct environment keys (Requirement 42.9)", () => {
  it("accepts separate and distinct dev and prod keys", () => {
    const res = validateDistinctEnvironmentKeys("mock-dev-key-111", "mock-prod-key-222");
    assert.equal(res.valid, true);
    assert.equal(res.reason, undefined);
  });

  it("rejects identical dev and prod keys (Requirement 42.9)", () => {
    const res = validateDistinctEnvironmentKeys("shared-mock-key-111", "shared-mock-key-111");
    assert.equal(res.valid, false);
    assert.ok(res.reason?.includes("Requirement 42.9"));
  });

  it("rejects missing or empty keys", () => {
    assert.equal(validateDistinctEnvironmentKeys("", "mock-prod-key-222").valid, false);
    assert.equal(validateDistinctEnvironmentKeys("mock-dev-key-111", "").valid, false);
    assert.equal(validateDistinctEnvironmentKeys(undefined, "mock-prod-key-222").valid, false);
  });
});

describe("credential-vault: Kiro API key storage (Requirement 42.7)", () => {
  it("accepts valid necro-owned 0o600 secret file in development", () => {
    const res = validateKiroKeyStorage(
      {
        storageType: "file",
        filePath: "/var/run/secrets/kiro-key.txt",
        fileOwner: "necro",
        fileMode: 0o600,
      },
      "development"
    );
    assert.equal(res.valid, true);
    assert.equal(res.violations.length, 0);
  });

  it("accepts 0o400 read-only mode for necro", () => {
    const res = validateKiroKeyStorage(
      {
        storageType: "file",
        filePath: "/var/run/secrets/kiro-key.txt",
        fileOwner: "necro",
        fileMode: "0400",
      },
      "development"
    );
    assert.equal(res.valid, true);
  });

  it("rejects non-file storage in development", () => {
    const res = validateKiroKeyStorage(
      {
        storageType: "host_secret_store",
      },
      "development"
    );
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.includes("stored in a file")));
  });

  it("rejects non-necro ownership in development", () => {
    const res = validateKiroKeyStorage(
      {
        storageType: "file",
        fileOwner: "root",
        fileMode: 0o600,
      },
      "development"
    );
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.includes('"necro"')));
  });

  it("rejects group or world readable file permissions in development", () => {
    const res = validateKiroKeyStorage(
      {
        storageType: "file",
        fileOwner: "necro",
        fileMode: 0o644,
      },
      "development"
    );
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.includes("group or other permissions")));
  });

  it("accepts host secret store in production and rejects plain files", () => {
    const okProd = validateKiroKeyStorage(
      { storageType: "host_secret_store" },
      "production"
    );
    assert.equal(okProd.valid, true);

    const badProd = validateKiroKeyStorage(
      { storageType: "file", filePath: "/tmp/key.txt" },
      "production"
    );
    assert.equal(badProd.valid, false);
    assert.ok(badProd.violations.some((v) => v.includes("host secret store")));
  });
});

describe("credential-vault: Docker PAT, Instabox key and GitService token validations", () => {
  it("rejects Docker PAT in development environment (Requirement 42.11)", () => {
    const resDevWithPat = validateDockerPatStorage("development", true);
    assert.equal(resDevWithPat.valid, false);
    assert.ok(resDevWithPat.violations[0].includes("Requirement 42.11"));

    const resDevNoPat = validateDockerPatStorage("development", false);
    assert.equal(resDevNoPat.valid, true);

    const resProdWithPat = validateDockerPatStorage("production", true);
    assert.equal(resProdWithPat.valid, true);
  });

  it("validates Instabox API key storage location (Requirements 42.17, 42.20)", () => {
    const okOwner = validateInstaboxKeyStorage("owner_local_machine");
    assert.equal(okOwner.valid, true);

    const badDevBox = validateInstaboxKeyStorage("dev_box");
    assert.equal(badDevBox.valid, false);

    const badBox = validateInstaboxKeyStorage("box_environment");
    assert.equal(badBox.valid, false);
  });

  it("validates GitService token hold constraint (Requirement 42.10)", () => {
    const okGitService = validateGitServiceTokenHold("GitService");
    assert.equal(okGitService.valid, true);

    const badHolder = validateGitServiceTokenHold("NecromancerWorker");
    assert.equal(badHolder.valid, false);
    assert.ok(badHolder.violations[0].includes("held exclusively by GitService"));
  });
});

describe("credential-vault: Box environment and Box files exclusion (Requirements 42.8, 42.11, 42.19, 42.20)", () => {
  const inventory: SecretInventory = {
    kiroApiKeyDev: "mock-kiro-key-dev-abc",
    kiroApiKeyProd: "mock-kiro-key-prod-xyz",
    instaboxApiKey: "mock-instabox-secret-999",
    githubToken: "mock-github-token-secret-888",
    dockerPat: "mock-docker-pat-secret-777",
    adminSecret: "mock-admin-secret-666",
    devBoxSshAddress: "mock-devbox-ssh-target",
  };

  it("passes clean Box environment", () => {
    const env = {
      NODE_ENV: "test",
      RUN_ID: "run-42",
      LANG: "en_US.UTF-8",
    };
    const res = validateBoxEnvironment(env, inventory);
    assert.equal(res.valid, true);
    assert.equal(res.violations.length, 0);
  });

  it("detects Kiro API key in Box environment (Requirement 42.8)", () => {
    const env = {
      RUN_ID: "run-42",
      TEST_VAR: "value-with-mock-kiro-key-dev-abc-inside",
    };
    const res = validateBoxEnvironment(env, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "kiro_api_key"));
  });

  it("detects Instabox key in Box environment (Requirement 42.20)", () => {
    const env = {
      RUN_ID: "run-42",
      INSTA_KEY: "mock-instabox-secret-999",
    };
    const res = validateBoxEnvironment(env, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "instabox_api_key"));
  });

  it("detects sensitive patterns in Box environment (Requirement 42.3)", () => {
    const env = {
      RUN_ID: "run-42",
      SAMPLE_PAT: "ghp_canaryToken1234567890",
    };
    const res = validateBoxEnvironment(env, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.length > 0);
  });

  it("passes clean Box files", () => {
    const files = [
      { path: "src/app.ts", content: "console.log('clean');" },
      { path: "package.json", content: '{"name": "test-pkg"}' },
    ];
    const res = validateBoxFiles(files, inventory);
    assert.equal(res.valid, true);
  });

  it("detects secrets in Box files (Requirement 42.8)", () => {
    const files = [
      { path: "src/config.ts", content: "const key = 'mock-kiro-key-prod-xyz';" },
    ];
    const res = validateBoxFiles(files, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "kiro_api_key"));
  });
});

describe("credential-vault: Skeleton environment checks (Requirement 42.19)", () => {
  const inventory: SecretInventory = {
    githubToken: "mock-gh-token-secret-1234",
    dockerPat: "mock-docker-pat-secret-1234",
  };

  it("passes clean Skeleton environment", () => {
    const env = {
      USER: "skel",
      PATH: "/usr/local/bin:/usr/bin",
    };
    const res = validateSkeletonEnvironment(env, inventory);
    assert.equal(res.valid, true);
  });

  it("rejects GitHub tokens in Skeleton environment (Requirement 42.19)", () => {
    const env = {
      USER: "skel",
      GITHUB_TOKEN: "mock-gh-token-secret-1234",
    };
    const res = validateSkeletonEnvironment(env, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "github_token"));
  });
});

describe("credential-vault: stored events, logs, artifacts, and docs (Requirements 42.8, 42.12, 42.13)", () => {
  const inventory: SecretInventory = {
    kiroApiKeyDev: "mock-kiro-key-dev-abc",
    instaboxApiKey: "mock-instabox-secret-999",
    adminSecret: "mock-admin-secret-666",
    devBoxSshAddress: "mock-devbox-ssh-target",
  };

  it("validates stored event payloads", () => {
    const cleanEvent = {
      type: "task.created",
      runId: "run-1",
      data: { taskId: "T1", title: "Build project" },
    };
    assert.equal(validateStoredEvent(cleanEvent, inventory).valid, true);

    const dirtyEvent = {
      type: "task.debug",
      runId: "run-1",
      data: { secret: "mock-admin-secret-666" },
    };
    const res = validateStoredEvent(dirtyEvent, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "admin_secret"));
  });

  it("validates command logs (stdout and stderr)", () => {
    const cleanLog = {
      stdout: "Building package...\nDone in 1.2s",
      stderr: "",
    };
    assert.equal(validateCommandLog(cleanLog, inventory).valid, true);

    const dirtyLog = "Error connecting to mock-devbox-ssh-target: connection refused";
    const res = validateCommandLog(dirtyLog, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "dev_box_ssh_address"));
  });

  it("validates artifacts", () => {
    const cleanArtifacts = {
      "all.patch": "--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-old\n+new",
      "report.md": "# Report\nExecution passed.",
    };
    assert.equal(validateArtifacts(cleanArtifacts, inventory).valid, true);

    const dirtyArtifacts = {
      "leak.txt": "Credentials: mock-instabox-secret-999",
    };
    assert.equal(validateArtifacts(dirtyArtifacts, inventory).valid, false);
  });

  it("validates repository files and documentation (Requirement 42.13)", () => {
    const cleanDocs = [
      { path: "README.md", content: "# Documentation\nHow to use the tool." },
    ];
    assert.equal(validateDocumentation(cleanDocs, inventory).valid, true);

    const dirtyDocs = [
      {
        path: "SETUP.md",
        content: "Connect to dev server via ssh mock-devbox-ssh-target for debugging.",
      },
    ];
    const res = validateDocumentation(dirtyDocs, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "dev_box_ssh_address"));
  });

  it("validates UI client bundle (Requirement 42.12)", () => {
    const cleanBundle = "function renderUI() { return '<div>Ready</div>'; }";
    assert.equal(validateUiBundle(cleanBundle, inventory).valid, true);

    const dirtyBundle = "const adminKey = 'mock-admin-secret-666'; initAdmin();";
    const res = validateUiBundle(dirtyBundle, inventory);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.secretKind === "admin_secret"));
  });
});

describe("credential-vault: live run eligibility and opt-out (Requirement 42.14, 42.9)", () => {
  it("refuses live run when content-use opt-out is false (Requirement 42.14)", () => {
    const res = validateLiveRunEligibility({
      contentUseOptOutSet: false,
      environment: "development",
      kiroApiKeyDev: "mock-dev-key-1",
    });
    assert.equal(res.allowed, false);
    assert.ok(res.violations.some((v) => v.includes("Requirement 42.14")));
  });

  it("refuses live run when required active environment key is missing", () => {
    const res = validateLiveRunEligibility({
      contentUseOptOutSet: true,
      environment: "development",
      kiroApiKeyDev: "",
    });
    assert.equal(res.allowed, false);
    assert.ok(res.violations.some((v) => v.includes("Development Kiro API key is missing")));
  });

  it("permits live run when opt-out is set and valid distinct key is configured", () => {
    const res = validateLiveRunEligibility({
      contentUseOptOutSet: true,
      environment: "development",
      kiroApiKeyDev: "mock-dev-key-1",
      kiroApiKeyProd: "mock-prod-key-2",
    });
    assert.equal(res.allowed, true);
    assert.equal(res.violations.length, 0);
  });
});

describe("credential-vault: admin review and redaction publication workflow (Requirement 42.15)", () => {
  const runData = {
    runId: "run-101",
    summary: "Refactored legacy package",
    logSample: "Compiled successfully",
  };

  it("creates a publication request with status pending", () => {
    const record = createPublicationRequest("run-101", "history", runData);
    assert.equal(record.runId, "run-101");
    assert.equal(record.target, "history");
    assert.equal(record.status, "pending");
    assert.equal(record.redacted, false);
  });

  it("performs admin review and transitions status", () => {
    const initial = createPublicationRequest("run-101", "history", runData);
    const reviewed = adminReviewRun(initial, {
      adminUser: "admin-operator",
      approved: true,
      notes: "Looks ready for review",
    });

    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.reviewedBy, "admin-operator");
    assert.ok(reviewed.reviewedAt);

    // Rejection case
    const rejected = adminReviewRun(initial, {
      adminUser: "admin-operator",
      approved: false,
      notes: "Unverified run",
    });
    assert.equal(rejected.status, "rejected");
  });

  it("redacts run data cleanly", () => {
    const raw = {
      message: "Build finished",
      details: { token: "ghp_canaryTokenSecret12345" },
    };
    const initial = createPublicationRequest("run-102", "replay", raw);
    const redacted = adminRedactRun(initial);

    assert.equal(redacted.redacted, true);
    assert.ok(redacted.publishedData);
    const details = (redacted.publishedData as any).details;
    assert.equal(details.token, "[REDACTED]");
  });

  it("validates publication criteria (Requirement 42.15)", () => {
    const req = createPublicationRequest("run-103", "history", runData);

    // Unreviewed fails
    const val1 = validateRunForPublication(req);
    assert.equal(val1.canPublish, false);
    assert.ok(val1.violations.some((v) => v.includes("admin review")));

    // Reviewed but unredacted fails
    const reviewed = adminReviewRun(req, { adminUser: "admin", approved: true });
    const val2 = validateRunForPublication(reviewed);
    assert.equal(val2.canPublish, false);
    assert.ok(val2.violations.some((v) => v.includes("undergo redaction")));

    // Reviewed and redacted passes
    const redacted = adminRedactRun(reviewed);
    const val3 = validateRunForPublication(redacted);
    assert.equal(val3.canPublish, true);
  });

  it("publishes run when all criteria pass", () => {
    const req = createPublicationRequest("run-104", "history", runData);
    const reviewed = adminReviewRun(req, { adminUser: "admin", approved: true });
    const redacted = adminRedactRun(reviewed);

    const pubResult = publishRun(redacted);
    assert.equal(pubResult.success, true);
    assert.equal(pubResult.record.status, "approved");
  });
});

describe("credential-vault: CredentialVault class and factory", () => {
  it("encapsulates environment configuration and child process env", () => {
    const vault = createCredentialVault({
      environment: "development",
      secrets: {
        kiroApiKeyDev: "mock-dev-key-123",
        kiroApiKeyProd: "mock-prod-key-456",
        githubToken: "mock-gh-token-789",
      },
    });

    assert.equal(vault.getEnvironment(), "development");
    assert.equal(vault.getActiveKiroKey(), "mock-dev-key-123");
    assert.deepEqual(vault.getKiroCliChildEnv(), {
      KIRO_API_KEY: "mock-dev-key-123",
    });

    const distinctRes = vault.validateDistinctKeys();
    assert.equal(distinctRes.valid, true);
  });

  it("validates live run and publication workflow through vault instance", () => {
    const vault = new CredentialVault({
      environment: "development",
      secrets: {
        kiroApiKeyDev: "mock-dev-key-abc",
        kiroApiKeyProd: "mock-prod-key-xyz",
        adminSecret: "mock-admin-secret-test",
      },
    });

    const liveCheck = vault.validateLiveRun(true);
    assert.equal(liveCheck.allowed, true);

    const req = vault.createPublicationRequest("run-201", "history", { text: "clean run" });
    const reviewed = vault.adminReviewRun(req, { adminUser: "admin", approved: true });
    const redacted = vault.adminRedactRun(reviewed);

    const pubRes = vault.publishRun(redacted);
    assert.equal(pubRes.success, true);
    assert.equal(pubRes.record.status, "approved");
  });
});
