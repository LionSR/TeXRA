/**
 * Default in-process implementation of {@link AgentTrace}.
 *
 * This is the agent-general core: no MESSAGE_TYPES, no TeXRA-specific
 * sugar. Product-specific helpers are plain functions in `helpers.ts` /
 * `toolUseHelpers.ts` that operate on the emitted event stream.
 *
 * Responsibilities at the emit boundary (one place, not many):
 *   - fan out to the sinks it was built with
 *   - swallow per-sink exceptions so one bad sink can't break the run
 */
import { writeLogLine } from '@logger/logSink';
import { RUN_OUTCOME, type LogLevel, type RunOutcome } from '@shared/schemas';
import { generateShortId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { AgentEvent, StreamKind } from './events';
import type {
  AgentTrace,
  AgentTraceSink,
  LogOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
} from './AgentTrace';

const CHANNEL = 'TraceEmitter';

export class TraceEmitter implements AgentTrace {
  /** The sinks this trace was built with, in order; null once it closed. */
  private sinks: readonly AgentTraceSink[] | null;

  constructor(...sinks: readonly AgentTraceSink[]) {
    this.sinks = sinks;
  }

  // ─── SSoT primitives ───────────────────────────────────────────────

  /** End the trace with its run: an event emitted after this reaches no
   *  sink, since the run it would describe has ended. */
  close(): void {
    this.sinks = null;
  }

  emit(event: AgentEvent): void {
    for (const sink of this.sinks ?? []) {
      try {
        sink(event);
      } catch (err) {
        // A misbehaving sink must not break the run. Write the entry
        // to the host log sink directly (not back through this emitter, and
        // not through a fiber: `emit` is the trace plane's one synchronous
        // publication point) so a throwing sink is diagnosable without
        // recursing into the trace stream.
        // `warn`, not `debug`: swallowing a sink fault at debug level is
        // the quiet-degradation shape the guardrail forbids, and it matches the
        // sibling session plane (`SessionHandle.publish`) and the app-signal
        // bus, whose delivery fiber warns and keeps its subscription.
        writeLogLine(
          'WARN',
          CHANNEL,
          `Trace sink threw while handling event: ${toErrorMessage(err)}`,
        );
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

  // ─── Stages ────────────────────────────────────────────────────────

  openStage(label: string, options: StageOptions = {}): StageHandle {
    const id = generateShortId();
    this.emit({
      type: 'stage.start',
      id,
      label,
      parentId: options.parent?.id,
      kind: options.kind,
      index: options.index,
      total: options.total,
    });
    return new StageHandleImpl(this, id);
  }

  // ─── Streams ───────────────────────────────────────────────────────

  openRun(kind: StreamKind, options: StreamOptions = {}): StreamHandle {
    const id = generateShortId();
    const emitStart = () => this.emit({ type: 'stream.start', id, kind });

    if (options.deferStart) {
      return new StreamHandleImpl(this, id, emitStart);
    }

    emitStart();
    return new StreamHandleImpl(this, id, null);
  }
}

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

class StreamHandleImpl implements StreamHandle {
  // Chunks are buffered in an array and joined once at finalize so a long
  // stream costs O(n) instead of repeated full-buffer string copies.
  private readonly chunks: string[] = [];
  private finalText: string | undefined;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
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
    this.trace.emit({ type: 'stream.chunk', id: this.id, text });
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
    this.trace.emit({
      type: 'stream.end',
      id: this.id,
      finalText: this.finalText,
    });
    return this.finalText;
  }
}
