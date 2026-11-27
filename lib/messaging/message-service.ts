// Task 21.1: Two-way MessageService and per-Skeleton mailboxes.
// Requirements: 27.1-27.16.
//
// The Necromancer owns every Skeleton mailbox. Every message is stored as an
// event in the EventStore and in the recipient's mailbox. Delivery either
// queues the message for `_session/steer` / post-command prompt injection, or
// cancels the running turn at once ("Interrupt now").

import type { EventStore } from "../events/event-store";
import {
  CONTAINER_SOCKET_MARKERS,
  DESTRUCTIVE_HOST_BINARIES,
  PRIVILEGE_COMMAND_HEADS,
  checkCommandHardBlocks,
  isHostBindVolumeMount,
} from "../policy/hard-blocks";
import { redactText } from "../security/redactor";

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

// Tier 3 hard-block scanning for user instructions. Free-text instructions are
// prose, so the whole sentence must never be fed to the argv checker: doing so
// flags benign wording ("the CI image has no sudo", "run pytest -v /tests").
// Instead each shell clause is inspected for real command forms and dangerous
// Tier 3 targets only.
//
// Clauses are separated on newlines, command chaining and subshell/backtick
// openers so `sudo` is only a command when it actually starts a command.
const SHELL_CLAUSE_SEPARATOR = /\r?\n|;|&&|\|\||\||\(|\)|`/;

// Prose instructions that try to lift the budget ceiling in words.
const BUDGET_BYPASS_PHRASES: readonly RegExp[] = [
  /ignore\s+(?:the\s+)?(?:budget|spend\s+limit|cap|ceiling)\b/i,
  /bypass\s+(?:the\s+)?(?:budget|spend\s+limit|cap|ceiling|limit)\b/i,
  /(?:raise|increase|lift|remove)\s+(?:the\s+)?(?:budget|cap|ceiling)\s+(?:beyond|past|above|over|without)\b/i,
  /(?:exceed|surpass)\s+(?:the\s+)?(?:budget|cap|ceiling)\s+ceiling\b/i,
  /(?:no|without\s+any)\s+(?:budget|cap|ceiling)\s+limit\b/i,
  /budget\s+ceiling\s+(?:does\s*n[o'’]?t|doesnt|does\s+not|is\s+not)\s+apply\b/i,
];

function shellBasename(token: string): string {
  const trimmed = token.trim().replace(/^["']+|["']+$/g, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

function clauseTokens(clause: string): string[] {
  return clause.split(/\s+/).filter(Boolean);
}

/**
 * Destructive root operations (`rm -rf /`, `dd of=/dev/sda`) are a Tier 3 hit
 * wherever they appear in a clause, so "run sudo rm -rf /" is still refused.
 * The argv checker is only handed the slice that begins at the `rm`/`dd`
 * binary, so its other checks cannot false-positive on surrounding prose.
 */
function clauseHasDestructiveHostOp(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const base = shellBasename(tokens[i]);
    if (base !== "rm" && base !== "dd") continue;
    const result = checkCommandHardBlocks(tokens.slice(i));
    if (result.blocked && result.code === "HARD_BLOCK_DESTRUCTIVE_HOST_OP") {
      return true;
    }
  }
  return false;
}


/**
 * Rejects a user instruction that would violate a Tier 3 hard block
 * (Requirement 27.13). Only user/builder instructions are scanned, and only
 * real shell/command forms or dangerous Tier 3 targets are matched so ordinary
 * prose is never rejected.
 */
export function assertMessageNotHardBlocked(
  from: MessageSender,
  intent: MessageIntent,
  text: string
): void {
  if (from !== "user") return;
  if (intent === "nudge" || !text) return;

  for (const phrase of BUDGET_BYPASS_PHRASES) {
    if (phrase.test(text)) {
      throw new MessageError(
        "Message instruction violates a Tier 3 hard block: instruction attempts to bypass the budget ceiling",
        "HARD_BLOCK"
      );
    }
  }

  for (const clause of text.split(SHELL_CLAUSE_SEPARATOR)) {
    const trimmedClause = clause.trim();
    if (!trimmedClause) continue;

    for (const marker of CONTAINER_SOCKET_MARKERS) {
      if (trimmedClause.includes(marker)) {
        throw new MessageError(
          `Message instruction violates a Tier 3 hard block: instruction references container runtime socket '${marker}'`,
          "HARD_BLOCK"
        );
      }
    }

    const tokens = clauseTokens(trimmedClause);
    if (tokens.length === 0) continue;

    const head = shellBasename(tokens[0]);
    if (PRIVILEGE_COMMAND_HEADS.has(head)) {
      throw new MessageError(
        `Message instruction violates a Tier 3 hard block: instruction invokes '${head}' at the start of a command`,
        "HARD_BLOCK"
      );
    }
    if (DESTRUCTIVE_HOST_BINARIES.has(head)) {
      throw new MessageError(
        `Message instruction violates a Tier 3 hard block: instruction invokes destructive host operation '${head}'`,
        "HARD_BLOCK"
      );
    }
    if (isHostBindVolumeMount(tokens)) {
      throw new MessageError(
        "Message instruction violates a Tier 3 hard block: instruction bind-mounts a host path",
        "HARD_BLOCK"
      );
    }
    if (clauseHasDestructiveHostOp(tokens)) {
      throw new MessageError(
        "Message instruction violates a Tier 3 hard block: instruction performs a destructive host operation",
        "HARD_BLOCK"
      );
    }
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
    const to = input.to;
    let actual: MailboxOwnerRole | undefined;
    if (to === "necromancer") {
      actual = "necromancer";
    } else if ((MAILBOX_ROLES as readonly string[]).includes(to)) {
      actual = to as MailboxOwnerRole;
    } else if (input.skeletonId && this.roleBySkeletonId[input.skeletonId]) {
      actual = this.roleBySkeletonId[input.skeletonId];
    } else if (this.roleBySkeletonId[to]) {
      actual = this.roleBySkeletonId[to];
    }

    if (actual) {
      if (input.recipientRole && input.recipientRole !== actual) {
        throw new MessageError(
          `Recipient role '${input.recipientRole}' conflicts with the actual recipient '${to}' role '${actual}'`,
          "ROLE_MISMATCH"
        );
      }
      return actual;
    }

    if (input.recipientRole) {
      return input.recipientRole;
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
    const delivery: DeliveryMode = input.delivery ?? "after_command";
    if (
      delivery === "interrupt_now" &&
      (recipientRole === "warden" || recipientRole === "scribe")
    ) {
      throw new MessageError(
        `Delivery mode 'interrupt_now' cannot target a ${recipientRole} (Requirement 27.9-27.11)`,
        "FORBIDDEN_TARGET"
      );
    }
    validateMessageIntent(recipientRole, input.intent, text, input.from);
    assertMessageNotHardBlocked(input.from, input.intent, text);

    this.seq += 1;
    const id = input.id ?? `${input.runId}:msg:${this.seq}`;
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

    // Event before commit: append the event first so a failed write leaves no
    // message or mailbox state behind.
    this.emit(record.runId, "message.sent", record.from, record);

    this.messages.set(id, record);
    this.appendToMailbox(record.to, record);
    if (record.cc === "necromancer") {
      this.appendToMailbox("necromancer", record);
    }

    // Receiving a message never resets a Skeleton's silence clock; only the
    // Skeleton's own activity does (Requirement 27.7).
    if (input.from === "skeleton") {
      this.noteActivity(record.skeletonId ?? record.to, record.createdAt);
    }
    return record;
  }

  private appendToMailbox(owner: string, record: MessageRecord): void {
    const key = `${record.runId}\u0000${owner}`;
    const box = this.mailboxes.get(key) ?? [];
    box.push(record);
    this.mailboxes.set(key, box);
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
        text: redactText(record.text),
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
    if (record.state !== "sent") {
      return record;
    }
    let resolved: DeliveryStrategy;
    if (strategy) {
      resolved = strategy;
    } else if (record.delivery === "interrupt_now") {
      resolved = "interrupt";
    } else {
      resolved = record.deliveryStrategy === "post_command_prompt" ? "post_command_prompt" : "steer";
    }
    const deliveredAt = this.now();
    const updated: MessageRecord = {
      ...record,
      state: "delivered",
      deliveredAt,
      deliveryStrategy: resolved,
    };
    // Event before commit.
    this.emit(record.runId, "message.delivered", "necromancer", updated, {
      strategy: resolved,
    });
    record.state = "delivered";
    record.deliveredAt = deliveredAt;
    record.deliveryStrategy = resolved;
    return record;
  }

  /** Marks a message Acknowledged after an `ack_message` call (Requirement 27.5). */
  acknowledge(id: string): MessageRecord {
    const record = this.getMessage(id);
    if (record.state === "sent") {
      this.deliver(id);
    }
    if (record.state !== "delivered") {
      return record;
    }
    const acknowledgedAt = this.now();
    const updated: MessageRecord = {
      ...record,
      state: "acknowledged",
      acknowledgedAt,
    };
    // Event before commit.
    this.emit(record.runId, "message.acked", "skeleton", updated, {
      strategy: record.deliveryStrategy,
    });
    record.state = "acknowledged";
    record.acknowledgedAt = acknowledgedAt;
    return record;
  }

  /**
   * All messages for a mailbox owner, in insertion order. When `runId` is given
   * only that run's mailbox is returned; otherwise mailboxes are aggregated
   * across runs in insertion order.
   */
  getMailbox(owner: string, runId?: string): MessageRecord[] {
    if (runId !== undefined) {
      return [...(this.mailboxes.get(`${runId}\u0000${owner}`) ?? [])];
    }
    return [...this.messages.values()].filter(
      (m) => m.to === owner || m.cc === owner
    );
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
   * Registers a Skeleton and its baseline activity timestamp before any tool
   * call or log line has been recorded, so silence can be measured from run
   * start rather than defaulting to "now".
   */
  registerSkeleton(skeletonId: string, startedAt?: number): void {
    this.lastActivityAt.set(skeletonId, startedAt ?? this.now());
    this.nudgedSinceActivity.set(skeletonId, false);
  }

  /**
   * When a Skeleton has made no tool call and written no log line for the
   * silent limit, sends a nudge (Requirement 27.7). Idempotent until activity
   * is recorded again.
   */
  checkSilence(
    runId: string,
    skeletonId: string,
    options?: { now?: number; recipientRole?: MailboxOwnerRole; startedAt?: number }
  ): SilenceCheckResult {
    const now = options?.now ?? this.now();
    const last =
      this.lastActivityAt.get(skeletonId) ?? options?.startedAt ?? now;
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

