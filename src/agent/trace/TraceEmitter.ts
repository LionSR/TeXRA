/**
 * Default in-process implementation of {@link AgentTrace}.
 *
 * This is the agent-general core: no MESSAGE_TYPES, no TeXRA-specific
 * sugar. Product-specific helpers are plain functions in `helpers.ts` /
 * `toolUseHelpers.ts` that operate on the emitted event stream.
 *
 * Responsibilities at the emit boundary (one place, not many):
 *   - stamp `stageId` from the AsyncLocalStorage scope
 *   - fan out to subscribers
 *   - swallow per-subscriber exceptions so one bad sink can't break the run
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import * as logger from '@logger/logUtils';
import {
  RUN_OUTCOME,
  type RunOutcome,
  type UpdateStreamUsagePayload,
} from '@shared/schemas';
import { generateShortId } from '@utils/core';
import { createListenerSet } from '@utils/core/listenerSet';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type {
  AgentEvent,
  ContextStateData,
  StreamKind,
  ToolStatus,
} from './events';
import type {
  AgentTrace,
  AgentTraceSubscriber,
  DomainEventInput,
  LogOptions,
  StagedEmitOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
  UsageEmitOptions,
} from './AgentTrace';

export class TraceEmitter implements AgentTrace {
  private readonly subscribers = createListenerSet<AgentTraceSubscriber>();

  /**
   * Per-instance stage scope. Kept on the instance — NOT a module singleton —
   * so a stage opened on one trace can never leak as the ambient parent of a
   * DIFFERENT trace. Cross-trace inheritance is the bug class behind orphaned
   * subagent transcripts (a child run's "Run:" stage inheriting the
   * orchestrator's tool-use stage id, absent from the child's own stream).
   * Within a single trace, ambient nesting works exactly as before.
   * See docs/proposals/2026-05-30-progress-grouping-refactor.md (R1).
   */
  private readonly stageScope = new AsyncLocalStorage<string[]>();

  private currentStageStack(): string[] {
    return this.stageScope.getStore() ?? [];
  }

  // ─── SSoT primitives ───────────────────────────────────────────────

  subscribe(subscriber: AgentTraceSubscriber): () => void {
    return this.subscribers.add(subscriber);
  }

  emit(event: AgentEvent): void {
    // Single resolve point — stage stamp wins from the event itself if
    // the caller supplied one; otherwise fall back to the active scope.
    const stamped: AgentEvent =
      event.stageId !== undefined
        ? event
        : ({
            ...event,
            stageId: this.currentStageStack().at(-1),
          } as AgentEvent);

    for (const sub of this.subscribers) {
      try {
        sub(stamped);
      } catch (err) {
        // A misbehaving subscriber must not break the run. Log via the
        // output-channel logger (not back through this emitter) so a throwing
        // sink is diagnosable without recursing into the trace stream.
        // `warn`, not `debug`: swallowing a subscriber fault at debug level is
        // the quiet-degradation shape the guardrail forbids, and it matches the
        // sibling fan-out bus (`SessionEventHub.emit`). `AppSignals.emit`
        // deliberately re-throws instead — a different, documented contract.
        logger.warn(
          'TraceEmitter',
          `Trace subscriber threw while handling event: ${toErrorMessage(err)}`,
        );
      }
    }
  }

  activeStageId(): string | undefined {
    return this.currentStageStack().at(-1);
  }

  withStage<T>(
    stageId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!stageId) return Promise.resolve(fn());
    const nextStack = [...this.currentStageStack(), stageId];
    return this.stageScope.run(nextStack, () => Promise.resolve(fn()));
  }

  // ─── Plain logging ─────────────────────────────────────────────────

  debug(message: string, options: LogOptions = {}): void {
    this.emitLog('debug', message, options);
  }

  info(message: string, options: LogOptions = {}): void {
    this.emitLog('info', message, options);
  }

  warn(message: string, options: LogOptions = {}): void {
    this.emitLog('warn', message, options);
  }

  error(message: string, options: LogOptions = {}): void {
    this.emitLog('error', message, options);
  }

  protected emitLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    options: LogOptions,
  ): void {
    this.emit({
      type: 'log',
      level,
      message,
      data: options.data,
      messageType: options.messageType,
      verbose: options.verbose,
      stageId: options.stageId,
    });
  }

  // ─── Structured emitters ───────────────────────────────────────────

  usage(
    payload: UpdateStreamUsagePayload,
    options: UsageEmitOptions = {},
  ): void {
    this.emit({
      type: 'usage',
      payload,
      recordTranscript: options.recordTranscript,
      stageId: options.stageId,
    });
  }

  contextState(
    snapshot: ContextStateData,
    options: StagedEmitOptions = {},
  ): void {
    this.emit({
      type: 'context.state',
      inputTokens: snapshot.inputTokens,
      contextWindow: snapshot.contextWindow,
      stageId: options.stageId,
    });
  }

  toolStart(
    input: { logId: string; toolName: string; input: unknown },
    options: StagedEmitOptions = {},
  ): void {
    this.emit({
      type: 'tool.start',
      logId: input.logId,
      toolName: input.toolName,
      input: input.input,
      stageId: options.stageId,
    });
  }

  toolEnd(
    input: { logId: string; status: ToolStatus; result?: unknown },
    options: StagedEmitOptions = {},
  ): void {
    this.emit({
      type: 'tool.end',
      logId: input.logId,
      status: input.status,
      result: input.result,
      stageId: options.stageId,
    });
  }

  domain(input: DomainEventInput): void {
    this.emit({
      type: 'domain',
      key: input.key,
      data: input.data,
      text: input.text,
      stageId: input.stageId,
    });
  }

  responseFinalized(text: string, options: StagedEmitOptions = {}): void {
    this.emit({
      type: 'response.finalized',
      text,
      stageId: options.stageId,
    });
  }

  // ─── Stages ────────────────────────────────────────────────────────

  openStage(label: string, options: StageOptions = {}): StageHandle {
    const defaultStatus = options.defaultStatus ?? RUN_OUTCOME.COMPLETED;
    const parentId =
      options.parent?.id ?? options.parentId ?? this.activeStageId();

    if (options.skip) {
      return new SkippedStageHandle(this, parentId);
    }

    const id = options.id ?? generateShortId();
    this.emit({
      type: 'stage.start',
      id,
      label,
      parentId,
      kind: options.kind,
      index: options.index,
      total: options.total,
    });
    return new StageHandleImpl(this, id, defaultStatus);
  }

  // ─── Streams ───────────────────────────────────────────────────────

  openStream(kind: StreamKind, options: StreamOptions = {}): StreamHandle {
    const id = options.id ?? generateShortId();
    const phaseOnly = options.phaseOnly === true;

    if (options.progressViewEnabled === false) {
      // Local-only buffering — chunks never emit. `finalize` returns the
      // text but nothing reaches subscribers.
      return new StreamHandleImpl(NO_EMIT, id, phaseOnly, null);
    }

    const emit: TraceEmitFn = (event) => this.emit(event);
    // Resolve the stage now so a deferred start lands in the same group an
    // eager start would have used, not whatever scope is active when the
    // first chunk finally arrives.
    const stageId = options.stageId ?? this.activeStageId();
    const emitStart = () => emit({ type: 'stream.start', id, kind, stageId });

    if (options.deferStart) {
      return new StreamHandleImpl(emit, id, phaseOnly, emitStart);
    }

    emitStart();
    return new StreamHandleImpl(emit, id, phaseOnly, null);
  }
}

/** Sink a stream handle writes through; `NO_EMIT` mutes it entirely. */
type TraceEmitFn = (event: AgentEvent) => void;

const NO_EMIT: TraceEmitFn = () => undefined;

class StageHandleImpl implements StageHandle {
  private ended = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
    private readonly defaultStatus: RunOutcome,
  ) {}

  end(status?: RunOutcome): void {
    if (this.ended) return;
    this.ended = true;
    this.trace.emit({
      type: 'stage.end',
      id: this.id,
      status: status ?? this.defaultStatus,
    });
  }

  async within<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.trace.withStage(this.id, fn);
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      const result = await this.within(fn);
      this.end();
      return result;
    } catch (err) {
      this.end(RUN_OUTCOME.FAILED);
      throw err;
    }
  }

  child(label: string, options: StageOptions = {}): StageHandle {
    return this.trace.openStage(label, { ...options, parent: this });
  }
}

/** Stage handle used when `skip: true` — propagates parent context but emits nothing. */
class SkippedStageHandle implements StageHandle {
  readonly id: string | undefined = undefined;

  constructor(
    private readonly trace: TraceEmitter,
    private readonly parentId: string | undefined,
  ) {}

  end(_status?: RunOutcome): void {
    // Skipped stages never opened a group; nothing to end.
  }

  async within<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.trace.withStage(this.parentId, fn);
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.within(fn);
  }

  child(label: string, options: StageOptions = {}): StageHandle {
    return this.trace.openStage(label, {
      ...options,
      parentId: options.parentId ?? this.parentId,
    });
  }
}

class StreamHandleImpl implements StreamHandle {
  // Chunks are buffered in an array and joined once at finalize so a long
  // stream costs O(n) instead of repeated full-buffer string copies.
  private readonly chunks: string[] = [];
  private finalText: string | undefined;

  constructor(
    private readonly emit: TraceEmitFn,
    readonly id: string,
    private readonly phaseOnly: boolean,
    /**
     * Deferred `stream.start` emission (see `StreamOptions.deferStart`); null
     * once started — eager streams are constructed already started. A deferred
     * stream finalized without content emits no events at all, while a
     * finalize that carries text emits the start/end pair so reasoning that
     * only arrives in the final response still lands as a single entry.
     */
    private pendingStart: (() => void) | null,
  ) {}

  private start(): void {
    const pending = this.pendingStart;
    this.pendingStart = null;
    pending?.();
  }

  append(text: string): void {
    if (this.finalText !== undefined || !text) return;
    this.start();
    this.chunks.push(text);
    if (this.phaseOnly) return;
    this.emit({ type: 'stream.chunk', id: this.id, text });
  }

  finalize(finalText?: string): string {
    if (this.finalText !== undefined) return this.finalText;
    this.finalText =
      typeof finalText === 'string' ? finalText : this.chunks.join('');
    // Deferred and nothing to say: the phase never happened, so the stream
    // leaves no trace at all.
    if (this.pendingStart !== null && this.finalText.length === 0) {
      return this.finalText;
    }
    this.start();
    this.emit({
      type: 'stream.end',
      id: this.id,
      finalText:
        !this.phaseOnly && typeof finalText === 'string'
          ? finalText
          : undefined,
    });
    return this.finalText;
  }
}
