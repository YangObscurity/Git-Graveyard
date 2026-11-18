import type { DatabaseSync } from "node:sqlite";
import type {
  EventData,
  EventEnvelope,
  EventInput,
  EventKind,
  EvidenceRef,
  GetEventsOptions,
  RedactionEventInput,
} from "./event-store";
import { EventStore } from "./event-store";
import type { LogStore } from "./log-store";

export type {
  EventData,
  EventEnvelope,
  EventInput,
  EventKind,
  EvidenceRef,
  GetEventsOptions,
  RedactionEventInput,
};

export interface RedactionOptions {
  secrets?: string[];
  patterns?: RegExp[];
  redactionMask?: string;
  mask?: string;
  autoRegisterEnvSecrets?: boolean;
}

export interface EventTapOptions extends RedactionOptions {
  eventStore?: EventStore;
  storeOptions?: string | DatabaseSync | { path?: string; db?: DatabaseSync; busyTimeout?: number };
  logStore?: LogStore;
}

import {
  DEFAULT_REDACTION_MASK,
  SENSITIVE_PATTERNS,
  HOST_DETAIL_PATTERNS,
  SECRET_ENV_VARS,
  getEnvSecrets,
  redactText,
  redactValue,
  redactEventData,
} from "../security/redactor";

export {
  DEFAULT_REDACTION_MASK,
  SENSITIVE_PATTERNS,
  HOST_DETAIL_PATTERNS,
  SECRET_ENV_VARS,
  getEnvSecrets,
  redactText,
  redactValue,
  redactEventData,
};

export function redactEventInput(
  input: EventInput,
  options?: RedactionOptions
): EventInput {
  if (!input || typeof input !== "object") {
    return input;
  }

  const data = redactEventData(input.data, options);
  const copy: EventInput = {
    ...input,
    data,
  };

  if (typeof copy.actor === "string") {
    copy.actor = redactText(copy.actor, options);
  }
  if (typeof copy.skeletonId === "string") {
    copy.skeletonId = redactText(copy.skeletonId, options);
  }
  if (typeof copy.taskId === "string") {
    copy.taskId = redactText(copy.taskId, options);
  }

  return copy;
}

export function redactEvent(
  event: EventEnvelope,
  options?: RedactionOptions
): EventEnvelope {
  if (!event || typeof event !== "object") {
    return event;
  }

  const data = redactEventData(event.data, options);
  const copy: EventEnvelope = {
    ...event,
    data,
  };

  if (typeof copy.actor === "string") {
    copy.actor = redactText(copy.actor, options);
  }
  if (typeof copy.skeletonId === "string") {
    copy.skeletonId = redactText(copy.skeletonId, options);
  }
  if (typeof copy.taskId === "string") {
    copy.taskId = redactText(copy.taskId, options);
  }

  return copy;
}

interface AdminRedactionInfo {
  redactedSeqs: Set<number>;
  extraSecrets: Set<string>;
  extraPatterns: RegExp[];
}

export class EventTap {
  readonly eventStore: EventStore;
  readonly logStore?: LogStore;
  private readonly options: EventTapOptions;
  private readonly registeredSecrets: Set<string>;
  private readonly customPatterns: RegExp[];
  private readonly mask: string;

  constructor(
    storeOrOptions?: EventStore | EventTapOptions,
    options?: EventTapOptions
  ) {
    if (storeOrOptions instanceof EventStore) {
      this.eventStore = storeOrOptions;
      this.options = options ?? {};
    } else if (
      storeOrOptions &&
      typeof (storeOrOptions as EventStore).append === "function" &&
      typeof (storeOrOptions as EventStore).getEvents === "function"
    ) {
      this.eventStore = storeOrOptions as EventStore;
      this.options = options ?? {};
    } else {
      const opts = (storeOrOptions as EventTapOptions) ?? {};
      this.options = opts;
      this.eventStore = opts.eventStore ?? new EventStore(opts.storeOptions);
    }

    this.logStore = this.options.logStore;
    this.mask =
      this.options.redactionMask ?? this.options.mask ?? DEFAULT_REDACTION_MASK;
    this.registeredSecrets = new Set<string>();
    this.customPatterns = [...(this.options.patterns ?? [])];

    if (this.options.secrets) {
      for (const secret of this.options.secrets) {
        if (typeof secret === "string" && secret.length > 0) {
          this.registeredSecrets.add(secret);
        }
      }
    }
  }

  registerSecret(secret: string): void {
    if (typeof secret === "string" && secret.length > 0) {
      this.registeredSecrets.add(secret);
    }
  }

  registerSecrets(secrets: Iterable<string>): void {
    for (const secret of secrets) {
      this.registerSecret(secret);
    }
  }

  addPattern(pattern: RegExp): void {
    if (pattern instanceof RegExp) {
      this.customPatterns.push(pattern);
    }
  }

  getRegisteredSecrets(): string[] {
    return Array.from(this.registeredSecrets);
  }

  private getRedactionOptions(): RedactionOptions {
    const liveSecrets = new Set<string>(this.registeredSecrets);
    if (this.options.autoRegisterEnvSecrets !== false) {
      for (const secret of getEnvSecrets()) {
        liveSecrets.add(secret);
      }
    }
    return {
      secrets: Array.from(liveSecrets),
      patterns: this.customPatterns,
      redactionMask: this.mask,
      autoRegisterEnvSecrets: false,
    };
  }

  redactText(text: string): string {
    return redactText(text, this.getRedactionOptions());
  }

  redactData(
    data: Partial<EventData> | Record<string, unknown> | undefined
  ): EventData {
    return redactEventData(data, this.getRedactionOptions());
  }

  redactEnvelope(envelope: EventEnvelope): EventEnvelope {
    return redactEvent(envelope, this.getRedactionOptions());
  }

  redactInput(input: EventInput): EventInput {
    return redactEventInput(input, this.getRedactionOptions());
  }

  // Write path: redact event before persisting to EventStore (Requirement 32.13)
  append(input: EventInput): EventEnvelope {
    const sanitized = this.redactInput(input);
    return this.eventStore.append(sanitized);
  }

  appendBatch(inputs: EventInput[]): EventEnvelope[] {
    if (!Array.isArray(inputs)) {
      throw new TypeError("inputs must be an array");
    }
    const sanitized = inputs.map((inp) => this.redactInput(inp));
    return this.eventStore.appendBatch(sanitized);
  }

  appendRedaction(
    runIdOrInput: string | RedactionEventInput,
    data?: Partial<EventData> | Record<string, unknown>,
    options?: {
      actor?: string;
      ts?: number;
      skeletonId?: string | null;
      taskId?: string | null;
      attempt?: number | null;
    }
  ): EventEnvelope {
    if (typeof runIdOrInput === "string") {
      const sanitizedData = this.redactData(data ?? {});
      return this.eventStore.appendRedaction(
        runIdOrInput,
        sanitizedData,
        options
      );
    }

    const sanitizedData = this.redactData(runIdOrInput.data ?? data ?? {});
    return this.eventStore.appendRedaction({
      ...runIdOrInput,
      data: sanitizedData,
    });
  }

  // Read path: query admin.redaction events and apply read-time redaction (Requirement 32.14)
  private getAdminRedactionInfo(runId: string): AdminRedactionInfo {
    const redactedSeqs = new Set<number>();
    const extraSecrets = new Set<string>();
    const extraPatterns: RegExp[] = [];

    try {
      const redactions = this.eventStore.getEvents(runId, {
        kind: "admin.redaction",
      });
      for (const red of redactions) {
        const d = red.data as Record<string, unknown> | undefined;
        if (!d) continue;

        if (typeof d.targetSeq === "number") {
          redactedSeqs.add(d.targetSeq);
        }
        if (typeof d.seq === "number") {
          redactedSeqs.add(d.seq);
        }
        if (typeof d.redactedSeq === "number") {
          redactedSeqs.add(d.redactedSeq);
        }
        if (Array.isArray(d.targetSeqs)) {
          for (const s of d.targetSeqs) {
            if (typeof s === "number") redactedSeqs.add(s);
          }
        }
        if (Array.isArray(d.redactedSeqs)) {
          for (const s of d.redactedSeqs) {
            if (typeof s === "number") redactedSeqs.add(s);
          }
        }
        if (Array.isArray(d.secrets)) {
          for (const s of d.secrets) {
            if (typeof s === "string" && s.length > 0) extraSecrets.add(s);
          }
        }
        if (Array.isArray(d.patterns)) {
          for (const p of d.patterns) {
            if (typeof p === "string" && p.length > 0) {
              try {
                extraPatterns.push(new RegExp(p, "g"));
              } catch {
                // Ignore invalid regex string in event data
              }
            }
          }
        }
      }
    } catch {
      // If table query fails, continue without admin redactions
    }

    return { redactedSeqs, extraSecrets, extraPatterns };
  }

  private applyReadRedaction(
    event: EventEnvelope,
    adminInfo: AdminRedactionInfo
  ): EventEnvelope {
    let currentEvent = event;

    if (adminInfo.redactedSeqs.has(event.seq)) {
      currentEvent = {
        ...currentEvent,
        data: {
          refs: [],
          redacted: true,
          message: "Redacted by the owner",
        },
      };
    }

    const baseOpts = this.getRedactionOptions();
    const readOptions: RedactionOptions = {
      ...baseOpts,
      secrets: [
        ...(baseOpts.secrets ?? []),
        ...Array.from(adminInfo.extraSecrets),
      ],
      patterns: [...this.customPatterns, ...adminInfo.extraPatterns],
    };

    return redactEvent(currentEvent, readOptions);
  }

  getEvents(runId: string, options?: GetEventsOptions): EventEnvelope[] {
    const rawEvents = this.eventStore.getEvents(runId, options);
    const adminInfo = this.getAdminRedactionInfo(runId);
    return rawEvents.map((evt) => this.applyReadRedaction(evt, adminInfo));
  }

  *iterateEvents(
    runId: string,
    options?: GetEventsOptions
  ): IterableIterator<EventEnvelope> {
    const adminInfo = this.getAdminRedactionInfo(runId);
    for (const rawEvt of this.eventStore.iterateEvents(runId, options)) {
      yield this.applyReadRedaction(rawEvt, adminInfo);
    }
  }

  getEvent(runId: string, seq: number): EventEnvelope | null {
    const rawEvt = this.eventStore.getEvent(runId, seq);
    if (!rawEvt) {
      return null;
    }
    const adminInfo = this.getAdminRedactionInfo(runId);
    return this.applyReadRedaction(rawEvt, adminInfo);
  }

  getLatestSeq(runId: string): number {
    return this.eventStore.getLatestSeq(runId);
  }

  getRunIds(): string[] {
    return this.eventStore.getRunIds();
  }

  countEvents(runId?: string): number {
    return this.eventStore.countEvents(runId);
  }

  close(): void {
    this.eventStore.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export function createEventTap(
  storeOrOptions?: EventStore | EventTapOptions
): EventTap {
  return new EventTap(storeOrOptions);
}
