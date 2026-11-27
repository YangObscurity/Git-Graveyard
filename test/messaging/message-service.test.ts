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

