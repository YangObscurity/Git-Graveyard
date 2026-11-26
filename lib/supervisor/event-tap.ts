// Task 9.6: EventTap update stream processor and usage routing
// Requirements: 16.11, 16.19, 16.20

import { EventEmitter } from "node:events";
import { EventStore, type EventEnvelope, type EventInput } from "../events/event-store";
import {
  DEFAULT_REDACTION_MASK,
  getEnvSecrets,
  HOST_DETAIL_PATTERNS,
  redactEventData,
  redactText,
  SENSITIVE_PATTERNS,
  type RedactionOptions,
} from "../events/event-tap";

/**
 * Interface representing a BudgetGovernor capable of receiving context usage updates.
 * Requirement 16.20.
 */
export interface BudgetGovernor {
  recordContextUsage?(
    contextUsage: unknown,
    context?: EventTapContext
  ): void | Promise<void>;
  handleContextUsage?(
    contextUsage: unknown,
    context?: EventTapContext
  ): void | Promise<void>;
  updateContextUsage?(
    contextUsage: unknown,
    context?: EventTapContext
  ): void | Promise<void>;
  onContextUsage?(
    contextUsage: unknown,
    context?: EventTapContext
  ): void | Promise<void>;
  routeContextUsage?(
    contextUsage: unknown,
    context?: EventTapContext
  ): void | Promise<void>;
  [key: string]: unknown;
}

export type BudgetGovernorLike =
  | BudgetGovernor
  | ((contextUsage: unknown, context?: EventTapContext) => void | Promise<void>);

export type SseDistributor = (event: EventEnvelope) => void | Promise<void>;

export interface SseBroadcaster {
  broadcast(event: EventEnvelope): void | Promise<void>;
}

export interface EventTapContext {
  runId?: string;
  skeletonId?: string;
  taskId?: string;
  role?: string;
  actor?: string;
  toolCallId?: string;
  attempt?: number;
  [key: string]: unknown;
}

export interface SupervisorEventTapOptions extends RedactionOptions {
  runId?: string;
  skeletonId?: string;
  taskId?: string;
  role?: string;
  actor?: string;
  eventStore?: EventStore;
  budgetGovernor?: BudgetGovernorLike;
  distributeSse?: SseDistributor;
  onSse?: SseDistributor;
  sseBroadcaster?: SseBroadcaster;
  autoRegisterEnvSecrets?: boolean;
  secretRegistry?: Iterable<string> | Set<string>;
}

/**
 * Unwraps an update object from various ACP wrapping conventions
 * (e.g. JSON-RPC params, wrapped { update: { ... } }, or direct payload).
 */
export function unwrapUpdate(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.params && typeof obj.params === "object") {
    return unwrapUpdate(obj.params);
  }
  if (obj.update && typeof obj.update === "object") {
    const inner = obj.update as Record<string, unknown>;
    return { ...obj, ...inner };
  }
  return obj;
}

/**
 * Checks whether an update represents the start or execution of a tool call.
 */
export function isToolCall(update: Record<string, unknown>): boolean {
  if (
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_start" ||
    update.kind === "tool_call" ||
    update.type === "tool_call"
  ) {
    // If status is completed or failed, or result is already present, it is a tool_result
    if (
      update.status === "completed" ||
      update.status === "failed" ||
      update.status === "error" ||
      update.result !== undefined ||
      update.output !== undefined
    ) {
      return false;
    }
    return true;
  }

  if (update.toolCall && typeof update.toolCall === "object") {
    const tc = update.toolCall as Record<string, unknown>;
    if (
      tc.status === "completed" ||
      tc.status === "failed" ||
      tc.result !== undefined ||
      update.toolResult !== undefined
    ) {
      return false;
    }
    return true;
  }

  // Update has toolCallId and a tool name/title/command without result or completion status
  if (
    (typeof update.toolCallId === "string" || typeof update.id === "string") &&
    (typeof update.tool === "string" ||
      typeof update.name === "string" ||
      typeof update.title === "string") &&
    update.result === undefined &&
    update.output === undefined &&
    update.status !== "completed" &&
    update.status !== "failed" &&
    update.toolResult === undefined
  ) {
    return true;
  }

  return false;
}

/**
 * Checks whether an update represents the completion or result of a tool call.
 */
export function isToolResult(update: Record<string, unknown>): boolean {
  if (
    update.sessionUpdate === "tool_result" ||
    update.sessionUpdate === "tool_call_result" ||
    update.kind === "tool_result" ||
    update.kind === "skeleton.tool_result" ||
    update.type === "tool_result"
  ) {
    return true;
  }

  if (update.toolResult !== undefined) {
    return true;
  }

  if (
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update" ||
    update.kind === "tool_call" ||
    update.toolCall
  ) {
    if (
      update.status === "completed" ||
      update.status === "failed" ||
      update.status === "error" ||
      update.result !== undefined ||
      update.output !== undefined
    ) {
      return true;
    }
    if (update.toolCall && typeof update.toolCall === "object") {
      const tc = update.toolCall as Record<string, unknown>;
      if (
        tc.status === "completed" ||
        tc.status === "failed" ||
        tc.result !== undefined ||
        tc.output !== undefined
      ) {
        return true;
      }
    }
  }

  if (
    (typeof update.toolCallId === "string" || typeof update.id === "string") &&
    (update.result !== undefined ||
      update.output !== undefined ||
      update.status === "completed" ||
      update.status === "failed")
  ) {
    return true;
  }

  return false;
}

/**
 * Checks whether an update represents agent text.
 */
export function isAgentText(update: Record<string, unknown>): boolean {
  if (
    update.sessionUpdate === "agent_message" ||
    update.sessionUpdate === "agent_text" ||
    update.sessionUpdate === "agent_thought" ||
    update.sessionUpdate === "agent_message_delta" ||
    update.type === "agent_text" ||
    update.type === "agent_message" ||
    update.kind === "agent_message" ||
    update.kind === "skeleton.log"
  ) {
    return true;
  }

  if (update.stream === "agent") {
    return true;
  }

  if (typeof update.agentText === "string" || typeof update.agentMessage === "string") {
    return true;
  }

  if (update.sessionUpdate === "text" && typeof update.text === "string") {
    return true;
  }

  if (
    update.sessionUpdate === "message" &&
    (typeof update.content === "string" || typeof update.text === "string")
  ) {
    return true;
  }

  // Generic object with text or content property without tool call or session_info indicators
  if (
    (typeof update.text === "string" || typeof update.content === "string") &&
    !isToolCall(update) &&
    !isToolResult(update) &&
    !isSessionInfo(update) &&
    !update.context_usage &&
    !update.contextUsage
  ) {
    return true;
  }

  return false;
}

/**
 * Checks whether an update represents a session_info_update with turn_completion.
 */
export function isSessionInfoWithTurnCompletion(
  update: Record<string, unknown>
): boolean {
  const hasTurnCompletion = Boolean(
    update.turn_completion ||
      update.turnCompletion ||
      (update.sessionInfo &&
        typeof update.sessionInfo === "object" &&
        ((update.sessionInfo as Record<string, unknown>).turn_completion ||
          (update.sessionInfo as Record<string, unknown>).turnCompletion))
  );

  if (hasTurnCompletion) {
    return true;
  }

  if (
    update.sessionUpdate === "session_info_update" ||
    update.type === "session_info_update" ||
    update.kind === "session_info_update"
  ) {
    return hasTurnCompletion;
  }

  return false;
}

/**
 * Checks whether an update is a generic session_info_update.
 */
export function isSessionInfo(update: Record<string, unknown>): boolean {
  return (
    update.sessionUpdate === "session_info_update" ||
    update.type === "session_info_update" ||
    update.kind === "session_info_update" ||
    update.sessionInfo !== undefined
  );
}

/**
 * Extracts context_usage payload from an update if present.
 */
export function extractContextUsage(update: Record<string, unknown>): unknown {
  if (update.context_usage !== undefined) {
    return update.context_usage;
  }
  if (update.contextUsage !== undefined) {
    return update.contextUsage;
  }
  if (update.sessionInfo && typeof update.sessionInfo === "object") {
    const si = update.sessionInfo as Record<string, unknown>;
    if (si.context_usage !== undefined) {
      return si.context_usage;
    }
    if (si.contextUsage !== undefined) {
      return si.contextUsage;
    }
  }
  if (update.sessionUpdate === "context_usage") {
    return update.data ?? update;
  }
  return undefined;
}

/**
 * Supervisor EventTap update stream processor and usage routing.
 * Requirements: 16.11, 16.19, 16.20.
 *
 * Responsibilities:
 * 1. Process incoming session/update streams.
 * 2. Tag events with run, Skeleton, task, and toolCallId.
 * 3. Redact secrets in all event fields and text.
 * 4. Persist to EventStore before SSE distribution.
 * 5. Map tool calls to skeleton.tool_call and skeleton.tool_result events.
 * 6. Map agent text to skeleton.log events with stream agent.
 * 7. Map session_info_update with turn_completion to skeleton.usage events.
 * 8. Route context_usage received in session/update directly to the BudgetGovernor.
 */
export class EventTap extends EventEmitter {
  readonly eventStore: EventStore;
  private readonly options: SupervisorEventTapOptions;
  private readonly registeredSecrets: Set<string>;
  private readonly customPatterns: RegExp[];
  private readonly mask: string;
  private autoRegisterEnvSecrets: boolean;

  private budgetGovernor?: BudgetGovernorLike;
  private distributeSseCallback?: SseDistributor;
  private sseBroadcaster?: SseBroadcaster;

  // Active tool calls tracking
  private activeToolCallIds: Set<string> = new Set();
  private latestToolCallId: string | null = null;
  private currentTaskId: string | null = null;

  constructor(options: SupervisorEventTapOptions = {}) {
    super();
    this.options = { ...options };
    this.eventStore = options.eventStore ?? new EventStore(":memory:");
    this.budgetGovernor = options.budgetGovernor;
    this.distributeSseCallback = options.distributeSse ?? options.onSse;
    this.sseBroadcaster = options.sseBroadcaster;
    this.currentTaskId = options.taskId ?? null;

    this.autoRegisterEnvSecrets = options.autoRegisterEnvSecrets !== false;
    this.mask = options.redactionMask ?? options.mask ?? DEFAULT_REDACTION_MASK;
    this.registeredSecrets = new Set<string>();
    this.customPatterns = [...(options.patterns ?? [])];

    if (options.secrets) {
      for (const secret of options.secrets) {
        if (typeof secret === "string" && secret.length > 0) {
          this.registeredSecrets.add(secret);
        }
      }
    }
    if (options.secretRegistry) {
      for (const secret of options.secretRegistry) {
        if (typeof secret === "string" && secret.length > 0) {
          this.registeredSecrets.add(secret);
        }
      }
    }
  }

  public registerSecret(secret: string): void {
    if (typeof secret === "string" && secret.length > 0) {
      this.registeredSecrets.add(secret);
    }
  }

  public registerSecrets(secrets: Iterable<string>): void {
    for (const secret of secrets) {
      this.registerSecret(secret);
    }
  }

  public getRegisteredSecrets(): string[] {
    return Array.from(this.registeredSecrets);
  }

  public getSecretRegistry(): string[] {
    return Array.from(this.registeredSecrets);
  }

  public isAutoRegisterEnvSecretsEnabled(): boolean {
    return this.autoRegisterEnvSecrets;
  }

  public setAutoRegisterEnvSecrets(enabled: boolean): void {
    this.autoRegisterEnvSecrets = Boolean(enabled);
  }

  public addPattern(pattern: RegExp): void {
    if (pattern instanceof RegExp) {
      this.customPatterns.push(pattern);
    }
  }

  public setBudgetGovernor(governor: BudgetGovernorLike): void {
    this.budgetGovernor = governor;
  }

  public setDistributeSse(distributor: SseDistributor): void {
    this.distributeSseCallback = distributor;
  }

  public setTaskId(taskId: string): void {
    this.currentTaskId = taskId;
  }

  public getActiveToolCallId(): string | null {
    return this.latestToolCallId;
  }

  private getRedactionOptions(): RedactionOptions {
    const liveSecrets = new Set<string>(this.registeredSecrets);
    if (this.autoRegisterEnvSecrets) {
      for (const secret of getEnvSecrets()) {
        liveSecrets.add(secret);
      }
    }
    return {
      secrets: Array.from(liveSecrets),
      patterns: this.customPatterns,
      redactionMask: this.mask,
      autoRegisterEnvSecrets: this.autoRegisterEnvSecrets,
    };
  }

  public redactText(text: string): string {
    return redactText(text, this.getRedactionOptions());
  }

  public redactData(
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    return redactEventData(data, this.getRedactionOptions());
  }

  private redactInput(input: EventInput): EventInput {
    const opts = this.getRedactionOptions();
    const data = redactEventData(input.data, opts);
    const copy: EventInput = {
      ...input,
      data,
    };

    if (typeof copy.actor === "string") {
      copy.actor = redactText(copy.actor, opts);
    }
    if (typeof copy.skeletonId === "string") {
      copy.skeletonId = redactText(copy.skeletonId, opts);
    }
    if (typeof copy.taskId === "string") {
      copy.taskId = redactText(copy.taskId, opts);
    }
    if (typeof (copy as any).toolCallId === "string") {
      (copy as any).toolCallId = redactText((copy as any).toolCallId, opts);
    }

    return copy;
  }

  private mergeContext(override?: EventTapContext): {
    runId: string;
    skeletonId?: string;
    taskId?: string;
    role?: string;
    actor: string;
    toolCallId?: string;
    attempt?: number;
  } {
    const runId =
      override?.runId ??
      (typeof this.options.runId === "string" ? this.options.runId : "run-unknown");
    const skeletonId = override?.skeletonId ?? this.options.skeletonId;
    const taskId = override?.taskId ?? this.currentTaskId ?? this.options.taskId;
    const role = override?.role ?? this.options.role;
    const actor =
      override?.actor ??
      (role ? role.toLowerCase() : undefined) ??
      this.options.actor ??
      "SkeletonSupervisor";
    const toolCallId = override?.toolCallId;
    const attempt = override?.attempt;

    return {
      runId,
      skeletonId,
      taskId,
      role,
      actor,
      toolCallId,
      attempt,
    };
  }

  /**
   * Routes context_usage received in session/update directly to the BudgetGovernor.
   * Requirement 16.20.
   */
  public async routeContextUsage(
    contextUsage: unknown,
    context?: EventTapContext
  ): Promise<void> {
    const merged = this.mergeContext(context);
    const tagContext = {
      runId: merged.runId,
      skeletonId: merged.skeletonId,
      taskId: merged.taskId,
      toolCallId: merged.toolCallId ?? this.latestToolCallId ?? undefined,
      role: merged.role,
    };

    if (this.budgetGovernor) {
      if (typeof (this.budgetGovernor as any).recordContextUsage === "function") {
        await (this.budgetGovernor as any).recordContextUsage(contextUsage, tagContext);
      } else if (
        typeof (this.budgetGovernor as any).handleContextUsage === "function"
      ) {
        await (this.budgetGovernor as any).handleContextUsage(contextUsage, tagContext);
      } else if (
        typeof (this.budgetGovernor as any).updateContextUsage === "function"
      ) {
        await (this.budgetGovernor as any).updateContextUsage(contextUsage, tagContext);
      } else if (
        typeof (this.budgetGovernor as any).routeContextUsage === "function"
      ) {
        await (this.budgetGovernor as any).routeContextUsage(contextUsage, tagContext);
      } else if (
        typeof (this.budgetGovernor as any).onContextUsage === "function"
      ) {
        await (this.budgetGovernor as any).onContextUsage(contextUsage, tagContext);
      } else if (typeof this.budgetGovernor === "function") {
        await (this.budgetGovernor as any)(contextUsage, tagContext);
      }
    }

    this.emit("context_usage", contextUsage, tagContext);
  }

  /**
   * Persists an event to EventStore before distributing it over SSE.
   * Requirement 16.11.
   */
  private async persistAndDistribute(input: EventInput): Promise<EventEnvelope> {
    // 1. Redact secrets in all fields
    const sanitizedInput = this.redactInput(input);

    // 2. Persist to EventStore FIRST
    const envelope = this.eventStore.append(sanitizedInput);

    // 3. Distribute over SSE AFTER persistence
    if (this.distributeSseCallback) {
      try {
        await this.distributeSseCallback(envelope);
      } catch (err) {
        this.emit("error", err);
      }
    }

    if (this.sseBroadcaster?.broadcast) {
      try {
        await this.sseBroadcaster.broadcast(envelope);
      } catch (err) {
        this.emit("error", err);
      }
    }

    this.emit("sse", envelope);
    this.emit("event", envelope);
    this.emit(envelope.kind, envelope);

    return envelope;
  }

  /**
   * Extracts toolCallId from update object.
   */
  private extractToolCallId(
    update: Record<string, unknown>,
    fallbackId?: string
  ): string {
    const candidate =
      update.toolCallId ??
      (update.toolCall && typeof update.toolCall === "object"
        ? (update.toolCall as Record<string, unknown>).id
        : undefined) ??
      (update.toolResult && typeof update.toolResult === "object"
        ? (update.toolResult as Record<string, unknown>).toolCallId
        : undefined) ??
      update.id ??
      update.callId ??
      fallbackId ??
      this.latestToolCallId ??
      "call-unknown";
    return String(candidate);
  }

  /**
   * Processes an incoming session/update, mapping events, redacting secrets,
   * persisting to EventStore, distributing over SSE, and routing context_usage.
   * Requirements: 16.11, 16.19, 16.20.
   */
  public async processUpdate(
    rawUpdate: unknown,
    contextOverride?: EventTapContext
  ): Promise<EventEnvelope[]> {
    const update = unwrapUpdate(rawUpdate);
    if (!update) {
      return [];
    }

    const merged = this.mergeContext(contextOverride);

    // If update contains taskId, update current tracking
    if (typeof update.taskId === "string") {
      this.currentTaskId = update.taskId;
      merged.taskId = update.taskId;
    }

    // Requirement 16.20: Route context_usage received in session/update directly to the BudgetGovernor
    const contextUsage = extractContextUsage(update);
    if (contextUsage !== undefined && contextUsage !== null) {
      await this.routeContextUsage(contextUsage, merged);
    }

    const envelopes: EventEnvelope[] = [];

    // Check if update contains both agent text and a tool call / result
    const hasAgentText = isAgentText(update);
    const hasToolCall = isToolCall(update);
    const hasToolResult = isToolResult(update);
    const hasTurnCompletion = isSessionInfoWithTurnCompletion(update);

    // 1. Map Agent Text -> skeleton.log (Requirement 16.19: "map agent text to skeleton.log events with stream agent")
    if (hasAgentText) {
      const textVal =
        update.text ??
        update.agentText ??
        update.agentMessage ??
        update.delta ??
        update.content ??
        update.message ??
        "";
      const textStr = typeof textVal === "string" ? textVal : JSON.stringify(textVal);

      const toolCallId =
        (typeof update.toolCallId === "string" ? update.toolCallId : undefined) ??
        merged.toolCallId ??
        this.latestToolCallId ??
        undefined;

      const eventData: Record<string, unknown> = {
        stream: "agent",
        text: textStr,
        refs: Array.isArray(update.refs) ? update.refs : [],
      };

      if (toolCallId) {
        eventData.toolCallId = toolCallId;
      }
      if (merged.runId) {
        eventData.runId = merged.runId;
      }
      if (merged.skeletonId) {
        eventData.skeletonId = merged.skeletonId;
      }
      if (merged.taskId) {
        eventData.taskId = merged.taskId;
      }

      const input: EventInput = {
        runId: merged.runId,
        kind: "skeleton.log",
        actor: merged.actor,
        skeletonId: merged.skeletonId ?? null,
        taskId: merged.taskId ?? null,
        attempt: merged.attempt ?? null,
        data: eventData,
      };

      if (toolCallId) {
        (input as any).toolCallId = toolCallId;
      }

      const env = await this.persistAndDistribute(input);
      envelopes.push(env);
    }

    // 2. Map Tool Call -> skeleton.tool_call (Requirement 16.19: "map tool calls to skeleton.tool_call and skeleton.tool_result events")
    if (hasToolCall) {
      const toolCallId = this.extractToolCallId(update, merged.toolCallId);
      this.activeToolCallIds.add(toolCallId);
      this.latestToolCallId = toolCallId;

      const toolName =
        update.tool ??
        update.name ??
        update.toolName ??
        (update.toolCall && typeof update.toolCall === "object"
          ? (update.toolCall as Record<string, unknown>).name ??
            (update.toolCall as Record<string, unknown>).title
          : undefined) ??
        update.title ??
        "unknown";

      const toolArgs =
        update.arguments ??
        update.args ??
        (update.toolCall && typeof update.toolCall === "object"
          ? (update.toolCall as Record<string, unknown>).arguments ??
            (update.toolCall as Record<string, unknown>).args
          : undefined) ??
        update.input ??
        update.params ??
        {};

      const eventData: Record<string, unknown> = {
        toolCallId,
        tool: String(toolName),
        arguments: toolArgs,
        refs: Array.isArray(update.refs) ? update.refs : [],
      };

      if (merged.runId) {
        eventData.runId = merged.runId;
      }
      if (merged.skeletonId) {
        eventData.skeletonId = merged.skeletonId;
      }
      if (merged.taskId) {
        eventData.taskId = merged.taskId;
      }

      const input: EventInput = {
        runId: merged.runId,
        kind: "skeleton.tool_call",
        actor: merged.actor,
        skeletonId: merged.skeletonId ?? null,
        taskId: merged.taskId ?? null,
        attempt: merged.attempt ?? null,
        data: eventData,
      };

      (input as any).toolCallId = toolCallId;

      const env = await this.persistAndDistribute(input);
      envelopes.push(env);
    }

    // 3. Map Tool Result -> skeleton.tool_result (Requirement 16.19)
    if (hasToolResult) {
      const toolCallId = this.extractToolCallId(update, merged.toolCallId);
      this.activeToolCallIds.delete(toolCallId);
      if (this.latestToolCallId === toolCallId) {
        const remaining = Array.from(this.activeToolCallIds);
        this.latestToolCallId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }

      const toolResultVal =
        update.result ??
        update.toolResult ??
        update.output ??
        (update.toolCall && typeof update.toolCall === "object"
          ? (update.toolCall as Record<string, unknown>).result
          : undefined) ??
        update.data;

      const toolOutput =
        update.output ??
        (toolResultVal && typeof toolResultVal === "object"
          ? (toolResultVal as Record<string, unknown>).output ??
            (toolResultVal as Record<string, unknown>).stdout ??
            (toolResultVal as Record<string, unknown>).stdoutTail
          : undefined);

      const status =
        update.status ??
        (toolResultVal && typeof toolResultVal === "object"
          ? (toolResultVal as Record<string, unknown>).status
          : undefined) ??
        (update.error ? "error" : "completed");

      const eventData: Record<string, unknown> = {
        toolCallId,
        result: toolResultVal,
        status: String(status),
        refs: Array.isArray(update.refs) ? update.refs : [],
      };

      if (toolOutput !== undefined) {
        eventData.output = toolOutput;
      }
      if (update.tool) {
        eventData.tool = update.tool;
      }
      if (update.exit_code !== undefined) {
        eventData.exit_code = update.exit_code;
      } else if (toolResultVal && typeof toolResultVal === "object" && (toolResultVal as any).exit_code !== undefined) {
        eventData.exit_code = (toolResultVal as any).exit_code;
      }

      if (merged.runId) {
        eventData.runId = merged.runId;
      }
      if (merged.skeletonId) {
        eventData.skeletonId = merged.skeletonId;
      }
      if (merged.taskId) {
        eventData.taskId = merged.taskId;
      }

      const input: EventInput = {
        runId: merged.runId,
        kind: "skeleton.tool_result",
        actor: merged.actor,
        skeletonId: merged.skeletonId ?? null,
        taskId: merged.taskId ?? null,
        attempt: merged.attempt ?? null,
        data: eventData,
      };

      (input as any).toolCallId = toolCallId;

      const env = await this.persistAndDistribute(input);
      envelopes.push(env);
    }

    // 4. Map Session Info Update with Turn Completion -> skeleton.usage (Requirement 16.19)
    if (hasTurnCompletion) {
      const tc =
        (update.turn_completion as Record<string, unknown> | undefined) ??
        (update.turnCompletion as Record<string, unknown> | undefined) ??
        (update.sessionInfo && typeof update.sessionInfo === "object"
          ? ((update.sessionInfo as Record<string, unknown>).turn_completion as Record<string, unknown>) ??
            ((update.sessionInfo as Record<string, unknown>).turnCompletion as Record<string, unknown>)
          : undefined) ??
        {};

      const credits =
        tc.credits !== undefined
          ? tc.credits
          : update.credits !== undefined
            ? update.credits
            : null;

      const eventData: Record<string, unknown> = {
        turn_completion: tc,
        credits: credits as number | null,
        refs: Array.isArray(update.refs) ? update.refs : [],
      };

      if (tc.tokens !== undefined) {
        eventData.tokens = tc.tokens;
      }
      if (tc.inputTokens !== undefined) {
        eventData.inputTokens = tc.inputTokens;
      }
      if (tc.outputTokens !== undefined) {
        eventData.outputTokens = tc.outputTokens;
      }
      if (tc.totalTokens !== undefined) {
        eventData.totalTokens = tc.totalTokens;
      }
      if (tc.durationMs !== undefined) {
        eventData.durationMs = tc.durationMs;
      }
      if (tc.model !== undefined) {
        eventData.model = tc.model;
      }

      const toolCallId =
        (typeof update.toolCallId === "string" ? update.toolCallId : undefined) ??
        merged.toolCallId ??
        this.latestToolCallId ??
        undefined;

      if (toolCallId) {
        eventData.toolCallId = toolCallId;
      }
      if (merged.runId) {
        eventData.runId = merged.runId;
      }
      if (merged.skeletonId) {
        eventData.skeletonId = merged.skeletonId;
      }
      if (merged.taskId) {
        eventData.taskId = merged.taskId;
      }

      const input: EventInput = {
        runId: merged.runId,
        kind: "skeleton.usage",
        actor: merged.actor,
        skeletonId: merged.skeletonId ?? null,
        taskId: merged.taskId ?? null,
        attempt: merged.attempt ?? null,
        data: eventData,
      };

      if (toolCallId) {
        (input as any).toolCallId = toolCallId;
      }

      const env = await this.persistAndDistribute(input);
      envelopes.push(env);
    }

    // 5. If update matched none of the above specific shapes, but contains state or custom update
    if (
      !hasAgentText &&
      !hasToolCall &&
      !hasToolResult &&
      !hasTurnCompletion &&
      contextUsage === undefined
    ) {
      const toolCallId =
        (typeof update.toolCallId === "string" ? update.toolCallId : undefined) ??
        merged.toolCallId ??
        this.latestToolCallId ??
        undefined;

      const eventData: Record<string, unknown> = {
        ...update,
        refs: Array.isArray(update.refs) ? update.refs : [],
      };

      if (toolCallId) {
        eventData.toolCallId = toolCallId;
      }
      if (merged.runId) {
        eventData.runId = merged.runId;
      }
      if (merged.skeletonId) {
        eventData.skeletonId = merged.skeletonId;
      }
      if (merged.taskId) {
        eventData.taskId = merged.taskId;
      }

      const kind =
        typeof update.kind === "string"
          ? update.kind
          : update.state !== undefined
            ? "skeleton.state"
            : "skeleton.log";

      const input: EventInput = {
        runId: merged.runId,
        kind,
        actor: merged.actor,
        skeletonId: merged.skeletonId ?? null,
        taskId: merged.taskId ?? null,
        attempt: merged.attempt ?? null,
        data: eventData,
      };

      if (toolCallId) {
        (input as any).toolCallId = toolCallId;
      }

      const env = await this.persistAndDistribute(input);
      envelopes.push(env);
    }

    return envelopes;
  }

  /**
   * Processes a stream or iterable of session/updates.
   */
  public async processStream(
    updates: Iterable<unknown> | AsyncIterable<unknown>,
    context?: EventTapContext
  ): Promise<EventEnvelope[]> {
    const envelopes: EventEnvelope[] = [];
    if (Symbol.asyncIterator in Object(updates)) {
      for await (const update of updates as AsyncIterable<unknown>) {
        const evts = await this.processUpdate(update, context);
        envelopes.push(...evts);
      }
    } else if (Symbol.iterator in Object(updates)) {
      for (const update of updates as Iterable<unknown>) {
        const evts = await this.processUpdate(update, context);
        envelopes.push(...evts);
      }
    }
    return envelopes;
  }

  public getEvents(runId: string, options?: any): EventEnvelope[] {
    return this.eventStore.getEvents(runId, options);
  }

  public close(): void {
    this.eventStore.close();
  }
}

export { EventTap as SupervisorEventTap };

export function createEventTap(options?: SupervisorEventTapOptions): EventTap {
  return new EventTap(options);
}

export function createSupervisorEventTap(
  options?: SupervisorEventTapOptions
): EventTap {
  return new EventTap(options);
}
