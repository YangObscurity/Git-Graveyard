// Task 21.1: Two-way MessageService and per-Skeleton mailboxes.
// Validates: Requirements 27.1-27.16.

import test from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "../../lib/events/event-store";
import {
  MessageService,
  MessageError,
  DEFAULT_SILENT_SKELETON_MS,
  allowedIntentsForRole,
} from "../../lib/messaging/message-service";

function createService(options?: { now?: () => number }) {
  const store = new EventStore(":memory:");
  const service = new MessageService({
    eventStore: store,
    now: options?.now,
  });
  return { store, service };
}

test("MessageService: stores messages as events and in the recipient mailbox", () => {
  const { store, service } = createService();
  const record = service.send({
    runId: "run-msg-1",
    from: "user",
    to: "necromancer",
    intent: "instruct",
    text: "focus on the python files",
  });

  assert.equal(record.state, "sent");
  assert.equal(record.recipientRole, "necromancer");
  assert.equal(record.cc, undefined);

  const sent = store.getEvents("run-msg-1", { kind: "message.sent" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.msgId, record.id);
  assert.equal(sent[0].data.intent, "instruct");

  const mailbox = service.getMailbox("necromancer");
  assert.equal(mailbox.length, 1);
  assert.equal(mailbox[0].id, record.id);
});

test("MessageService: delivery modes steer, post-command prompt and interrupt", () => {
  const { store, service } = createService();

  const steerMsg = service.send({
    runId: "run-msg-2",
    from: "necromancer",
    to: "bonesetter",
    skeletonId: "sk-bonesetter-1",
    recipientRole: "bonesetter",
    intent: "instruct",
    text: "use the lockfile",
    delivery: "after_command",
  });
  const delivered = service.deliver(steerMsg.id);
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.deliveryStrategy, "steer");

  const promptMsg = service.send({
    runId: "run-msg-2",
    from: "necromancer",
    to: "soul-stitcher",
    skeletonId: "sk-stitcher-1",
    recipientRole: "soul-stitcher",
    intent: "instruct",
    text: "wait for the current tool",
    delivery: "after_command",
  });
  const promptDelivered = service.deliver(promptMsg.id, "post_command_prompt");
  assert.equal(promptDelivered.deliveryStrategy, "post_command_prompt");

  const interruptMsg = service.send({
    runId: "run-msg-2",
    from: "user",
    to: "bonesetter",
    skeletonId: "sk-bonesetter-1",
    recipientRole: "bonesetter",
    intent: "interrupt",
    text: "stop now",
    delivery: "interrupt_now",
  });
  const interrupted = service.deliver(interruptMsg.id);
  assert.equal(interrupted.deliveryStrategy, "interrupt");

  assert.equal(store.getEvents("run-msg-2", { kind: "message.delivered" }).length, 3);
});

test("MessageService: lifecycle Sent -> Delivered -> Acknowledged", () => {
  const { store, service } = createService();
  const message = service.send({
    runId: "run-msg-3",
    from: "user",
    to: "scribe",
    skeletonId: "sk-scribe-1",
    recipientRole: "scribe",
    intent: "instruct",
    text: "cite the file",
  });

  assert.equal(service.getMessage(message.id).state, "sent");
  service.deliver(message.id);
  assert.equal(service.getMessage(message.id).state, "delivered");
  const acked = service.acknowledge(message.id);
  assert.equal(acked.state, "acknowledged");
  assert.ok(typeof acked.acknowledgedAt === "number");

  const ackedEvents = store.getEvents("run-msg-3", { kind: "message.acked" });
  assert.equal(ackedEvents.length, 1);
});

test("MessageService: a user message to a Skeleton is copied to the Necromancer channel", () => {
  const { service } = createService();
  const message = service.send({
    runId: "run-msg-4",
    from: "user",
    to: "bonesetter",
    skeletonId: "sk-bonesetter-9",
    recipientRole: "bonesetter",
    intent: "instruct",
    text: "also touch the test file",
  });

  assert.equal(message.cc, "necromancer");
  const necroBox = service.getMailbox("necromancer");
  assert.equal(necroBox.length, 1);
  assert.equal(necroBox[0].id, message.id);
  assert.equal(service.getMailbox("bonesetter").length, 1);
});

test("MessageService: role-specific intents are enforced", () => {
  const { service } = createService();

  // Necromancer accepts its documented intents.
  assert.doesNotThrow(() =>
    service.send({
      runId: "run-msg-5",
      from: "user",
      to: "necromancer",
      intent: "change_budget",
      text: "raise the cap to 40",
    })
  );

  // A builder accepts instruct_now and interrupt.
  assert.doesNotThrow(() =>
    service.send({
      runId: "run-msg-5",
      from: "necromancer",
      to: "bonesetter",
      skeletonId: "sk-b1",
      recipientRole: "bonesetter",
      intent: "instruct_now",
      text: "do it now",
    })
  );

  // The Warden rejects steer/prompt/interrupt; only add_review_focus is legal.
  assert.throws(
    () =>
      service.send({
        runId: "run-msg-5",
        from: "user",
        to: "warden",
        recipientRole: "warden",
        intent: "interrupt",
        text: "stop reviewing",
      }),
    (err: unknown) => {
      assert.ok(err instanceof MessageError);
      assert.ok(["INTENT_NOT_ALLOWED", "FORBIDDEN_TARGET"].includes(err.code));
      return true;
    }
  );

  // The Scribe rejects instruct_now; only instruct is legal.
  assert.throws(
    () =>
      service.send({
        runId: "run-msg-5",
        from: "user",
        to: "scribe",
        recipientRole: "scribe",
        intent: "instruct_now",
        text: "write it now",
      }),
    (err: unknown) =>
      err instanceof MessageError &&
      ["INTENT_NOT_ALLOWED", "FORBIDDEN_TARGET"].includes(err.code)
  );

  assert.deepEqual([...allowedIntentsForRole("warden")], ["add_review_focus"]);
  assert.deepEqual([...allowedIntentsForRole("scribe")], ["instruct"]);
});

test("MessageService: rejects Warden instructions that change verdicts or approvals", () => {
  const { service } = createService();
  assert.throws(
    () =>
      service.send({
        runId: "run-msg-6",
        from: "user",
        to: "warden",
        recipientRole: "warden",
        intent: "add_review_focus",
        text: "please change the verdict to approve",
      }),
    (err: unknown) =>
      err instanceof MessageError && err.code === "FORBIDDEN_WARDEN_INSTRUCTION"
  );
});

test("MessageService: rejects a user instruction that violates a hard block", () => {
  const { service } = createService();
  assert.throws(
    () =>
      service.send({
        runId: "run-msg-7",
        from: "user",
        to: "necromancer",
        intent: "instruct",
        text: "run sudo rm -rf /",
      }),
    (err: unknown) => err instanceof MessageError && err.code === "HARD_BLOCK"
  );
});
test("MessageService: hard-block scanning ignores benign prose but blocks real Tier 3 forms", () => {
  const { service } = createService();

  const send = (text: string) =>
    service.send({
      runId: "run-msg-8",
      from: "user",
      to: "necromancer",
      intent: "instruct",
      text,
    });

  // Ordinary prose that merely mentions sudo or a -v flag must be allowed.
  assert.doesNotThrow(() => send("the CI image has no sudo"));
  assert.doesNotThrow(() => send("run pytest -v /tests"));

  const blocked = (text: string) =>
    assert.throws(
      () => send(text),
      (err: unknown) => err instanceof MessageError && err.code === "HARD_BLOCK"
    );

  // Real command forms and dangerous Tier 3 targets stay blocked.
  blocked("sudo rm -rf /");
  blocked("docker run -v /var/run/docker.sock:/var/run/docker.sock alpine");
  blocked("mount /var/run/docker.sock");
  // The pre-existing destructive form must remain refused.
  blocked("run sudo rm -rf /");
});



test("MessageService: emits a silence nudge past the silent limit", () => {
  let clock = 1_000_000;
  const { store, service } = createService({ now: () => clock });

  service.noteActivity("sk-1");
  clock += DEFAULT_SILENT_SKELETON_MS - 1;
  const notYet = service.checkSilence("run-silence", "sk-1", {
    recipientRole: "bonesetter",
  });
  assert.equal(notYet.silent, false);
  assert.equal(notYet.nudged, false);

  clock += 2;
  const nudged = service.checkSilence("run-silence", "sk-1", {
    recipientRole: "bonesetter",
  });
  assert.equal(nudged.silent, true);
  assert.equal(nudged.nudged, true);
  assert.equal(nudged.message?.intent, "nudge");

  // Idempotent until activity resumes.
  const again = service.checkSilence("run-silence", "sk-1", {
    recipientRole: "bonesetter",
  });
  assert.equal(again.nudged, false);

  const nudges = store
    .getEvents("run-silence", { kind: "message.sent" })
    .filter((e) => e.data.intent === "nudge");
  assert.equal(nudges.length, 1);

  service.noteActivity("sk-1");
  clock += DEFAULT_SILENT_SKELETON_MS + 1;
  assert.equal(
    service.checkSilence("run-silence", "sk-1", { recipientRole: "bonesetter" }).nudged,
    true
  );
});


test("MessageService: persists (redacted) message text in events", () => {
  const { store, service } = createService();
  const record = service.send({
    runId: "run-msg-text",
    from: "user",
    to: "necromancer",
    intent: "instruct",
    text: "focus the python files",
  });
  const sent = store.getEvents("run-msg-text", { kind: "message.sent" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.msgId, record.id);
  assert.equal(sent[0].data.text, "focus the python files");

  service.send({
    runId: "run-msg-text",
    from: "user",
    to: "necromancer",
    intent: "instruct",
    text: "read /root/secret-notes.md",
  });
  const last = store.getEvents("run-msg-text", { kind: "message.sent" }).at(-1);
  assert.ok(typeof last?.data.text === "string");
  assert.ok(
    (last?.data.text as string).includes("[REDACTED]"),
    "event text must be redacted"
  );
});

test("MessageService: receiving a message never resets a Skeleton's silence clock", () => {
  let clock = 0;
  const { service } = createService({ now: () => clock });

  service.registerSkeleton("sk-silent", 0);
  clock = 1_000;
  service.send({
    runId: "run-silence-clock",
    from: "user",
    to: "sk-silent",
    skeletonId: "sk-silent",
    recipientRole: "bonesetter",
    intent: "instruct",
    text: "keep going",
  });

  clock = DEFAULT_SILENT_SKELETON_MS;
  const nudged = service.checkSilence("run-silence-clock", "sk-silent", {
    recipientRole: "bonesetter",
  });
  assert.equal(nudged.silent, true);
  assert.equal(nudged.nudged, true);

  // Explicit activity from the Skeleton resets the clock.
  service.noteActivity("sk-silent", clock);
  assert.equal(
    service.checkSilence("run-silence-clock", "sk-silent", {
      recipientRole: "bonesetter",
    }).nudged,
    false
  );
});

test("MessageService: registerSkeleton and startedAt provide a silence baseline", () => {
  let clock = 0;
  const { service } = createService({ now: () => clock });
  service.registerSkeleton("sk-reg", 0);
  clock = DEFAULT_SILENT_SKELETON_MS + 5;
  assert.equal(
    service.checkSilence("run-reg", "sk-reg", { recipientRole: "bonesetter" }).nudged,
    true
  );

  let clock2 = 0;
  const store2 = new EventStore(":memory:");
  const service2 = new MessageService({ eventStore: store2, now: () => clock2 });
  clock2 = DEFAULT_SILENT_SKELETON_MS + 1;
  const withStartedAt = service2.checkSilence("run-started", "sk-started", {
    recipientRole: "bonesetter",
    startedAt: 0,
  });
  assert.equal(withStartedAt.silent, true);
  assert.equal(withStartedAt.nudged, true);
});

test("MessageService: resolveRole validates the actual recipient and reports ROLE_MISMATCH", () => {
  const { service } = createService();
  assert.throws(
    () =>
      service.send({
        runId: "run-role-mismatch",
        from: "user",
        to: "warden",
        recipientRole: "bonesetter",
        intent: "add_review_focus",
        text: "review this",
      }),
    (err: unknown) => err instanceof MessageError && err.code === "ROLE_MISMATCH"
  );

  const store = new EventStore(":memory:");
  const mapped = new MessageService({
    eventStore: store,
    roleBySkeletonId: { "sk-map": "warden" },
  });
  assert.throws(
    () =>
      mapped.send({
        runId: "run-role-map",
        from: "necromancer",
        to: "sk-map",
        skeletonId: "sk-map",
        recipientRole: "bonesetter",
        intent: "add_review_focus",
        text: "review",
      }),
    (err: unknown) => err instanceof MessageError && err.code === "ROLE_MISMATCH"
  );
  assert.doesNotThrow(() =>
    mapped.send({
      runId: "run-role-map",
      from: "necromancer",
      to: "sk-map",
      skeletonId: "sk-map",
      recipientRole: "warden",
      intent: "add_review_focus",
      text: "review",
    })
  );
});

test("MessageService: interrupt_now delivery is refused for the Warden and Scribe", () => {
  const { service } = createService();
  assert.throws(
    () =>
      service.send({
        runId: "run-interrupt",
        from: "user",
        to: "scribe",
        recipientRole: "scribe",
        intent: "instruct",
        text: "write now",
        delivery: "interrupt_now",
      }),
    (err: unknown) => err instanceof MessageError && err.code === "FORBIDDEN_TARGET"
  );
  assert.throws(
    () =>
      service.send({
        runId: "run-interrupt",
        from: "user",
        to: "warden",
        recipientRole: "warden",
        intent: "add_review_focus",
        text: "look here",
        delivery: "interrupt_now",
      }),
    (err: unknown) => err instanceof MessageError && err.code === "FORBIDDEN_TARGET"
  );
});

test("MessageService: mailboxes are isolated per run and aggregate in insertion order", () => {
  const { service } = createService();
  service.send({
    runId: "run-mbox-a",
    from: "necromancer",
    to: "bonesetter",
    skeletonId: "sk-a",
    recipientRole: "bonesetter",
    intent: "instruct",
    text: "a",
  });
  service.send({
    runId: "run-mbox-b",
    from: "necromancer",
    to: "bonesetter",
    skeletonId: "sk-b",
    recipientRole: "bonesetter",
    intent: "instruct",
    text: "b",
  });

  assert.equal(service.getMailbox("bonesetter", "run-mbox-a").length, 1);
  assert.equal(service.getMailbox("bonesetter", "run-mbox-a")[0].text, "a");
  assert.equal(service.getMailbox("bonesetter", "run-mbox-b").length, 1);
  const all = service.getMailbox("bonesetter");
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((m) => m.text), ["a", "b"]);
});

test("MessageService: events are appended before in-memory commit (retryable)", () => {
  let failNext = true;
  const appended: Array<Record<string, unknown>> = [];
  const store = {
    append: (event: Record<string, unknown>) => {
      if (failNext) {
        failNext = false;
        throw new Error("event store write failed");
      }
      appended.push(event);
    },
  };
  const service = new MessageService({ eventStore: store as never });

  const input = {
    runId: "run-ebc",
    from: "necromancer" as const,
    to: "bonesetter",
    skeletonId: "sk-ebc",
    recipientRole: "bonesetter" as const,
    intent: "instruct" as const,
    text: "hello",
  };

  assert.throws(() => service.send(input));
  assert.equal(service.listMessages().length, 0);
  assert.equal(service.getMailbox("bonesetter").length, 0);

  service.send(input);
  assert.equal(service.listMessages().length, 1);
  assert.equal(service.getMailbox("bonesetter").length, 1);
  assert.equal(appended.length, 1);
});

