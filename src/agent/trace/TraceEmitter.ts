/**
 * Default in-process implementation of {@link AgentTrace}.
 *
 * This is the agent-general core: no MESSAGE_TYPES, no TeXRA-specific
 * sugar. Product-specific helpers are plain functions in `helpers.ts` /
 * `toolUseHelpers.ts` that operate on the emitted event stream.
 *
 * Responsibilities at the emit boundary (one place, not many):
 *   - fan out to subscribers
 *   - swallow per-subscriber exceptions so one bad sink can't break the run
 */
import { LOG_CHANNEL, writeLogEntry } from '@logger/logSink';
import {
  RUN_OUTCOME,
  type LogLevel,
  type RunOutcome,
  type ToolCallStatus,
  type ToolUseLog,
} from '@shared/schemas';
import { generateShortId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type {
  AgentEvent,
  ContextStateData,
  StreamKind,
  UsageReport,
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

const CHANNEL = 'TraceEmitter';

export class TraceEmitter implements AgentTrace {
  /**
   * Subscribers in registration order. `emit` iterates the live Set, so a
   * subscriber that unsubscribes during a dispatch (its own or a peer's) is
   * not visited afterwards — the same semantics as iterating `values()`.
   */
  private readonly subscribers = new Set<AgentTraceSubscriber>();

  // ─── SSoT primitives ───────────────────────────────────────────────

  subscribe(subscriber: AgentTraceSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: AgentEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        // A misbehaving subscriber must not break the run. Write the entry
        // to the host log sink directly (not back through this emitter, and
        // not through a fiber: `emit` is the trace plane's one synchronous
        // publication point) so a throwing sink is diagnosable without
        // recursing into the trace stream.
        // `warn`, not `debug`: swallowing a subscriber fault at debug level is
        // the quiet-degradation shape the guardrail forbids, and it matches the
        // sibling session plane (`SessionHandle.publish`) and the app-signal
        // bus, whose delivery fiber warns and keeps its subscription.
        writeLogEntry({
          level: 'WARN',
          fiberId: '',
          timestamp: new Date().toISOString(),
          message: `Trace subscriber threw while handling event: ${toErrorMessage(err)}`,
          cause: undefined,
          annotations: { [LOG_CHANNEL]: CHANNEL },
          spans: {},
        });
      }
    }
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

  private emitLog(level: LogLevel, message: string, options: LogOptions): void {
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

  usage(report: UsageReport, options: UsageEmitOptions = {}): void {
    this.emit({
      type: 'usage',
      runId: report.runId,
      usage: report.usage,
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
    input: {
      logId: string;
      status: ToolCallStatus;
      result?: Omit<ToolUseLog, 'status'>;
    },
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
    const parentId = options.parent?.id ?? options.parentId;

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
    return new StageHandleImpl(this, id);
  }

  // ─── Streams ───────────────────────────────────────────────────────

  openRun(kind: StreamKind, options: StreamOptions = {}): StreamHandle {
    const id = options.id ?? generateShortId();
    const phaseOnly = options.phaseOnly === true;

    if (options.progressViewEnabled === false) {
      // Local-only buffering — chunks never emit. `finalize` returns the
      // text but nothing reaches subscribers.
      return new StreamHandleImpl(NO_EMIT, id, phaseOnly, null);
    }

    const emit: TraceEmitFn = (event) => this.emit(event);
    const emitStart = () =>
      emit({ type: 'stream.start', id, kind, stageId: options.stageId });

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
  ) {}

  end(status?: RunOutcome): void {
    if (this.ended) return;
    this.ended = true;
    this.trace.emit({
      type: 'stage.end',
      id: this.id,
      status: status ?? RUN_OUTCOME.COMPLETED,
    });
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
     * once started — eager runs are constructed already started. A deferred
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
      finalText: this.phaseOnly ? undefined : this.finalText,
    });
    return this.finalText;
  }
}
