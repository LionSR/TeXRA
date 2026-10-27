/**
 * Default in-process implementation of {@link AgentTrace}.
 *
 * This is the agent-general core: no app-specific sugar; `MessageType`
 * is the only product vocabulary it takes. Product-specific helpers are plain
 * functions in `helpers.ts` that operate on the emitted event stream.
 *
 * It also owns how its streams read back: `responseText` picks the answer's
 * text out of the chunks it emits.
 *
 * Responsibilities at the emit boundary (one place, not many):
 *   - fan out to the sinks it was built with
 *   - swallow per-sink exceptions so one bad sink can't break the run
 */
import { Stream } from 'effect';

import { writeLogLine } from '@logger/logSink';
import {
  MESSAGE_TYPES,
  qualifyAggregateId,
  RUN_OUTCOME,
  toJsonValue,
  type RunId,
  type LogLevel,
  type MessageType,
  type RunOutcome,
  type ToolUseLog,
} from '@shared/schemas';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { generateShortId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { AgentEvent } from './events';
import type {
  AgentTrace,
  AgentTraceSink,
  LogOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
  ToolCardHandle,
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
        // sibling session plane (`SessionHandle.trace`) and the app-signal
        // bus, whose delivery fiber warns and keeps its subscription.
        writeLogLine(
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
      data: options.data === undefined ? undefined : toJsonValue(options.data),
      messageType: options.messageType,
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
    });
    return new StageHandleImpl(this, id);
  }

  // ─── Streams ───────────────────────────────────────────────────────

  openRun(kind: MessageType, options: StreamOptions = {}): StreamHandle {
    const id = generateShortId();
    const emitStart = () => this.emit({ type: 'stream.start', id, kind });

    if (options.deferStart) {
      return new StreamHandleImpl(this, id, emitStart);
    }

    emitStart();
    return new StreamHandleImpl(this, id, null);
  }

  // ─── Tool cards ────────────────────────────────────────────────────

  openToolCard(log: ToolUseLog): ToolCardHandle {
    const logId = generateShortId();
    this.emit({
      type: 'tool.start',
      logId,
      toolName: log.toolName ?? 'unknown',
      input: toJsonValue(log.input),
      ...(log.card ? { card: log.card } : {}),
    });
    if (log.status === undefined || log.status === 'in_progress')
      return new ToolCardHandleImpl(this, logId, log, true);
    this.emit({
      type: 'tool.end',
      logId,
      status: log.status,
      result: toJsonValue(log),
    });
    return new ToolCardHandleImpl(this, logId, log, false);
  }
}

class ToolCardHandleImpl implements ToolCardHandle {
  private readonly trace: TraceEmitter;
  private readonly logId: string;
  log: ToolUseLog;
  private open: boolean;

  constructor(
    trace: TraceEmitter,
    logId: string,
    log: ToolUseLog,
    open: boolean,
  ) {
    this.trace = trace;
    this.logId = logId;
    this.log = log;
    this.open = open;
  }

  update(log: ToolUseLog): void {
    const { status = 'completed', ...result } = log;
    this.log = log;
    this.open = status === 'in_progress';
    this.trace.emit({
      type: 'tool.end',
      logId: this.logId,
      status,
      result: toJsonValue(result),
    });
  }

  failIfOpen(): void {
    if (!this.open) return;
    const { status: _status, ...log } = this.log;
    this.update({
      ...log,
      error: 'The turn ended before this tool reported.',
      status: 'failed',
    });
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

/** A source trace fact on its run aggregate. Streaming chunks remain transient. */
export function runEventDraft(
  runId: RunId,
  event: AgentEvent,
): UnfoldedDraft | null {
  if (event.type === 'stream.chunk') return null;
  return { ...event, aggregateId: qualifyAggregateId('run', runId) };
}

/**
 * The model's answer text out of a run's events, chunk by chunk as it
 * streams: `run.events.pipe(responseText)`.
 *
 * A `stream.chunk` names only its stream, and a run streams more than its
 * answer: the model's thinking and what a running tool prints are chunks
 * too. This keeps the chunks of the streams that opened as a model response
 * and drops the rest. A model call that fails and is retried has already
 * streamed its partial answer; the retry's answer follows it.
 */
export const responseText = <E, R>(
  events: Stream.Stream<AgentEvent, E, R>,
): Stream.Stream<string, E, R> =>
  events.pipe(
    Stream.mapAccum(
      () => new Set<string>(),
      (answers, event): readonly [Set<string>, readonly string[]] => {
        if (
          event.type === 'stream.start' &&
          event.kind === MESSAGE_TYPES.MODEL_RESPONSE
        )
          answers.add(event.id);
        if (event.type === 'stream.end') answers.delete(event.id);
        return [
          answers,
          event.type === 'stream.chunk' && answers.has(event.id)
            ? [event.text]
            : [],
        ];
      },
    ),
  );
