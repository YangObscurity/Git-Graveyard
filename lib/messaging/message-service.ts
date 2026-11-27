// Task 21.1: Two-way MessageService and per-Skeleton mailboxes.
// Requirements: 27.1-27.16.
//
// The Necromancer owns every Skeleton mailbox. Every message is stored as an
// event in the EventStore and in the recipient's mailbox. Delivery either
// queues the message for `_session/steer` / post-command prompt injection, or
// cancels the running turn at once ("Interrupt now").

import type { EventStore } from "../events/event-store";
import { checkCommandHardBlocks } from "../policy/hard-blocks";

/** Structural sink so tests can pass a minimal EventStore double. */
export type MessageEventSink = Pick<EventStore, "append">;

export type MailboxOwnerRole =
  | "necromancer"
  | "planner"
  | "exhumer"
  | "bonesetter"
  | "soul-stitcher"
  | "warden"
  | "scribe";

export const MAILBOX_ROLES: readonly MailboxOwnerRole[] = [
  "necromancer",
  "planner",
  "exhumer",
  "bonesetter",
  "soul-stitcher",
  "warden",
  "scribe",
];

export const NECROMANCER_INTENTS = [
  "instruct",
  "revise_pact",
  "priority",
  "change_budget",
  "pause_run",
  "resume_run",
  "stop_run",
  "answer",
  "approve",
  "deny",
] as const;

export const BUILDER_INTENTS = [
  "instruct",
  "instruct_now",
  "interrupt",
  "re_raise",
  "lay_to_rest",
] as const;

export const WARDEN_INTENTS = ["add_review_focus"] as const;
export const SCRIBE_INTENTS = ["instruct"] as const;

export type NecromancerIntent = (typeof NECROMANCER_INTENTS)[number];
export type BuilderIntent = (typeof BUILDER_INTENTS)[number];
export type WardenIntent = (typeof WARDEN_INTENTS)[number];
export type ScribeIntent = (typeof SCRIBE_INTENTS)[number];
export type NudgeIntent = "nudge";
export type MessageIntent =
  | NecromancerIntent
  | BuilderIntent
  | WardenIntent
  | ScribeIntent
  | NudgeIntent;

/** Delivery choices offered by the Legion dashboard (Requirement 27.2/27.3). */
export type DeliveryMode = "after_command" | "interrupt_now";

/** How a queued "after_command" message actually reached the Skeleton. */
export type DeliveryStrategy = "steer" | "post_command_prompt" | "interrupt";

/** Message lifecycle (Requirement 27.5). */
export type MessageState = "sent" | "delivered" | "acknowledged";

export type MessageSender = "user" | "necromancer" | "skeleton" | "system";

export interface MessageRecord {
  id: string;
  runId: string;
  seq: number;
  from: MessageSender;
  to: string;
  recipientRole: MailboxOwnerRole;
  intent: MessageIntent;
  text: string;
  delivery: DeliveryMode;
  state: MessageState;
  cc?: string;
  skeletonId?: string;
  refs: string[];
  createdAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  deliveryStrategy?: DeliveryStrategy;
}

export class MessageError extends Error {
  readonly code: string;
  constructor(message: string, code = "MESSAGE_ERROR") {
    super(message);
    this.name = "MessageError";
    this.code = code;
    Object.setPrototypeOf(this, MessageError.prototype);
  }
}

/** Default silent-Skeleton limit (Requirement 30.3): 120 seconds. */
export const DEFAULT_SILENT_SKELETON_MS = 120_000;

export interface MessageServiceOptions {
  eventStore: MessageEventSink;
  now?: () => number;
  silentSkeletonMs?: number;
  /** Optional explicit role map for skeleton ids whose name is not the role. */
  roleBySkeletonId?: Record<string, MailboxOwnerRole>;
}

export interface SendMessageInput {
  runId: string;
  from: MessageSender;
  to: string;
  intent: MessageIntent;
  text?: string;
  delivery?: DeliveryMode;
  refs?: string[];
  skeletonId?: string;
  recipientRole?: MailboxOwnerRole;
  id?: string;
}

export interface SilenceCheckResult {
  silent: boolean;
  silentMs: number;
  nudged: boolean;
  message?: MessageRecord;
}

const BUILDER_ROLES: ReadonlySet<MailboxOwnerRole> = new Set([
  "planner",
  "exhumer",
  "bonesetter",
  "soul-stitcher",
]);

/** Role-specific intent allowlist (Requirements 27.8-27.11). */
export function allowedIntentsForRole(
  role: MailboxOwnerRole
): readonly MessageIntent[] {
  if (role === "necromancer") return NECROMANCER_INTENTS;
  if (role === "warden") return WARDEN_INTENTS;
  if (role === "scribe") return SCRIBE_INTENTS;
  if (BUILDER_ROLES.has(role)) return BUILDER_INTENTS;
  return [];
}

export function isBuilderRole(role: MailboxOwnerRole): boolean {
  return BUILDER_ROLES.has(role);
}

const STEER_PROMPT_INTERRUPT: ReadonlySet<MessageIntent> = new Set([
  "instruct",
  "instruct_now",
  "interrupt",
]);

// Requirement 27.15: the Warden's verdict, approvals and checkout are off limits.
const WARDEN_FORBIDDEN_PHRASES: RegExp[] = [
  /(?:change|alter|override|flip|set).{0,20}verdict/i,
  /grant.{0,20}approval/i,
  /approv.{0,20}(?:command|request)/i,
  /(?:read|access|write|open).{0,20}checkout/i,
];

/**
 * Validates a role-specific intent. Rejects any steer/prompt/interrupt action
 * that targets the Warden or the Scribe, and any Warden instruction that tries
 * to alter a verdict, grant an approval or touch the Warden checkout.
 */
export function validateMessageIntent(
  role: MailboxOwnerRole,
  intent: MessageIntent,
  text = "",
  from?: MessageSender
): void {
  // A nudge is a Necromancer-only system message to any Skeleton role.
  if (intent === "nudge") {
    if (from !== undefined && from !== "necromancer" && from !== "system") {
      throw new MessageError(
        "Only the Necromancer may send a nudge (Requirement 27.7)",
        "INTENT_NOT_ALLOWED"
      );
    }
    return;
  }
  const allowed = allowedIntentsForRole(role);
  // The Warden can never be steered, prompted or interrupted. The Scribe may
  // be instructed, but must not be prompted or interrupted.
  if (
    (role === "warden" && STEER_PROMPT_INTERRUPT.has(intent)) ||
    (role === "scribe" && intent !== "instruct" && STEER_PROMPT_INTERRUPT.has(intent))
  ) {
    throw new MessageError(
      `Message intent '${intent}' cannot steer, prompt or interrupt a ${role} (Requirement 27.9-27.11)`,
      "FORBIDDEN_TARGET"
    );
  }
  if (!allowed.includes(intent)) {
    throw new MessageError(
      `Message intent '${intent}' is not permitted for role '${role}' (Requirement 27.8-27.11)`,
      "INTENT_NOT_ALLOWED"
    );
  }
  if (role === "warden") {
    for (const pattern of WARDEN_FORBIDDEN_PHRASES) {
      if (pattern.test(text)) {
        throw new MessageError(
          "Message attempts to alter the Warden verdict, grant an approval or access the Warden checkout (Requirement 27.15)",
          "FORBIDDEN_WARDEN_INSTRUCTION"
        );
      }
    }
  }
}

/**
 * Rejects a user instruction that would violate a Tier 3 hard block
 * (Requirement 27.13). Only user/builder instructions are scanned.
 */
export function assertMessageNotHardBlocked(
  from: MessageSender,
  intent: MessageIntent,
  text: string
): void {
  if (from !== "user") return;
  if (intent === "nudge" || !text) return;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return;
  const result = checkCommandHardBlocks(tokens);
  if (result.blocked) {
    throw new MessageError(
      `Message instruction violates a Tier 3 hard block: ${result.reason}`,
      "HARD_BLOCK"
    );
  }
}


/**
 * Two-way messaging service. Stores every message as an EventStore event and
 * keeps a mailbox per Skeleton (and the Necromancer channel).
 */
export class MessageService {
  private readonly eventStore: MessageEventSink;
  private readonly now: () => number;
  readonly silentSkeletonMs: number;
  private readonly roleBySkeletonId: Record<string, MailboxOwnerRole>;

  private readonly messages = new Map<string, MessageRecord>();
  private readonly mailboxes = new Map<string, MessageRecord[]>();
  private readonly lastActivityAt = new Map<string, number>();
  private readonly nudgedSinceActivity = new Map<string, boolean>();
  private seq = 0;

  constructor(options: MessageServiceOptions) {
    if (!options || !options.eventStore || typeof options.eventStore.append !== "function") {
      throw new MessageError("MessageService requires an eventStore with append()", "INVALID_OPTIONS");
    }
    this.eventStore = options.eventStore;
    this.now = options.now ?? (() => Date.now());
    this.silentSkeletonMs = options.silentSkeletonMs ?? DEFAULT_SILENT_SKELETON_MS;
    this.roleBySkeletonId = options.roleBySkeletonId ?? {};
  }

  private resolveRole(input: SendMessageInput): MailboxOwnerRole {
    if (input.recipientRole) return input.recipientRole;
    const to = input.to;
    if (to === "necromancer") return "necromancer";
    if ((MAILBOX_ROLES as readonly string[]).includes(to)) {
      return to as MailboxOwnerRole;
    }
    if (input.skeletonId && this.roleBySkeletonId[input.skeletonId]) {
      return this.roleBySkeletonId[input.skeletonId];
    }
    if (this.roleBySkeletonId[to]) {
      return this.roleBySkeletonId[to];
    }
    throw new MessageError(
      `Cannot resolve a mailbox role for recipient '${to}'`,
      "UNKNOWN_RECIPIENT"
    );
  }

  /**
   * Stores a message, validates the role intent and copies a user-to-Skeleton
   * message onto the Necromancer channel with `cc: necromancer`.
   * Requirement 27.1, 27.6, 27.8-27.13, 27.15.
   */
  send(input: SendMessageInput): MessageRecord {
    if (!input || typeof input.runId !== "string" || !input.runId) {
      throw new MessageError("runId is required", "INVALID_INPUT");
    }
    if (!input.to || typeof input.to !== "string") {
      throw new MessageError("recipient 'to' is required", "INVALID_INPUT");
    }
    const recipientRole = this.resolveRole(input);
    const text = input.text ?? "";
    validateMessageIntent(recipientRole, input.intent, text, input.from);
    assertMessageNotHardBlocked(input.from, input.intent, text);

    this.seq += 1;
    const id = input.id ?? `${input.runId}:msg:${this.seq}`;
    const delivery: DeliveryMode = input.delivery ?? "after_command";
    const record: MessageRecord = {
      id,
      runId: input.runId,
      seq: this.seq,
      from: input.from,
      to: input.to,
      recipientRole,
      intent: input.intent,
      text,
      delivery,
      state: "sent",
      refs: Array.isArray(input.refs) ? [...input.refs] : [],
      createdAt: this.now(),
    };
    if (input.skeletonId) record.skeletonId = input.skeletonId;

    if (input.from === "user" && recipientRole !== "necromancer") {
      record.cc = "necromancer";
    }

    this.messages.set(id, record);
    this.appendToMailbox(record.to, record);
    if (record.cc === "necromancer") {
      this.appendToMailbox("necromancer", record);
    }

    this.emit(record.runId, "message.sent", record.from, record);
    this.noteActivity(record.to, record.createdAt);
    return record;
  }

  private appendToMailbox(owner: string, record: MessageRecord): void {
    const box = this.mailboxes.get(owner) ?? [];
    box.push(record);
    this.mailboxes.set(owner, box);
  }

  private emit(
    runId: string,
    kind: string,
    actor: string,
    record: MessageRecord,
    extra?: Record<string, unknown>
  ): void {
    this.eventStore.append({
      runId,
      kind,
      actor,
      data: {
        msgId: record.id,
        from: record.from,
        to: record.to,
        intent: record.intent,
        state: record.state,
        delivery: record.delivery,
        cc: record.cc,
        skeletonId: record.skeletonId,
        refs: record.refs,
        ...extra,
      },
      ts: this.now(),
      skeletonId: record.skeletonId ?? null,
    });
  }

  /** Returns the stored message record, or throws. */
  getMessage(id: string): MessageRecord {
    const record = this.messages.get(id);
    if (!record) {
      throw new MessageError(`Unknown message '${id}'`, "MESSAGE_NOT_FOUND");
    }
    return record;
  }

  /** Marks a message Delivered and emits `message.delivered` (Requirement 27.5). */
  deliver(id: string, strategy?: DeliveryStrategy): MessageRecord {
    const record = this.getMessage(id);
    if (record.state === "sent") {
      record.state = "delivered";
      record.deliveredAt = this.now();
      let resolved: DeliveryStrategy;
      if (strategy) {
        resolved = strategy;
      } else if (record.delivery === "interrupt_now") {
        resolved = "interrupt";
      } else {
        resolved = record.deliveryStrategy === "post_command_prompt" ? "post_command_prompt" : "steer";
      }
      record.deliveryStrategy = resolved;
      this.emit(record.runId, "message.delivered", "necromancer", record, {
        strategy: resolved,
      });
    }
    return record;
  }

  /** Marks a message Acknowledged after an `ack_message` call (Requirement 27.5). */
  acknowledge(id: string): MessageRecord {
    const record = this.getMessage(id);
    if (record.state === "sent") {
      this.deliver(id);
    }
    if (record.state === "delivered") {
      record.state = "acknowledged";
      record.acknowledgedAt = this.now();
      this.emit(record.runId, "message.acked", "skeleton", record, {
        strategy: record.deliveryStrategy,
      });
    }
    return record;
  }

  /** All messages for a mailbox owner, in insertion order. */
  getMailbox(owner: string): MessageRecord[] {
    return [...(this.mailboxes.get(owner) ?? [])];
  }

  /** All messages for a run, in insertion order. */
  listMessages(runId?: string): MessageRecord[] {
    const all = [...this.messages.values()];
    return runId ? all.filter((m) => m.runId === runId) : all;
  }

  /** Records Skeleton activity so silence can be measured (Requirement 27.7). */
  noteActivity(skeletonIdOrOwner: string, ts?: number): void {
    this.lastActivityAt.set(skeletonIdOrOwner, ts ?? this.now());
    this.nudgedSinceActivity.set(skeletonIdOrOwner, false);
  }

  /**
   * When a Skeleton has made no tool call and written no log line for the
   * silent limit, sends a nudge (Requirement 27.7). Idempotent until activity
   * is recorded again.
   */
  checkSilence(
    runId: string,
    skeletonId: string,
    options?: { now?: number; recipientRole?: MailboxOwnerRole }
  ): SilenceCheckResult {
    const now = options?.now ?? this.now();
    const last = this.lastActivityAt.get(skeletonId) ?? now;
    const silentMs = Math.max(0, now - last);
    const silent = silentMs >= this.silentSkeletonMs;
    if (!silent) {
      return { silent: false, silentMs, nudged: false };
    }
    if (this.nudgedSinceActivity.get(skeletonId)) {
      return { silent: true, silentMs, nudged: false };
    }

    const recipientRole =
      options?.recipientRole ??
      this.roleBySkeletonId[skeletonId] ??
      (skeletonId as MailboxOwnerRole);
    const nudge = this.send({
      runId,
      from: "necromancer",
      to: skeletonId,
      skeletonId,
      intent: "nudge",
      text: `Silent for ${Math.floor(silentMs / 1000)}s; report status.`,
      delivery: "after_command",
      recipientRole,
    });
    this.nudgedSinceActivity.set(skeletonId, true);
    return { silent: true, silentMs, nudged: true, message: nudge };
  }
}

