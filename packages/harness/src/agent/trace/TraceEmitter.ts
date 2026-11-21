/**
 * Default in-process implementation of {@link AgentTrace}.
 *
 * This is the agent-general core: no app-specific sugar; `MessageType`
 * is the only product vocabulary it takes. Product-specific helpers are plain
 * functions in `traceLogs.ts` over the {@link AgentTrace} interface.
 *
 * It also owns how its streams read back: `responseText` picks the answer's
 * text out of the chunks it emits.
 *
 * Every event reaches the one sink the trace was built with, until it
 * closes; a sink that throws is logged and does not break the run.
 */
import { Effect, Exit, Result, Schema, Stream } from 'effect';

import { raisedBy } from '@logger/formatLogData';
import { writeLogLine } from '@logger/logSink';
import {
  MESSAGE_TYPES,
  outcomeFromCause,
  RUN_OUTCOME,
  ToolCardEndSchema,
  formatIssuesForDiagnostics,
  toJsonValue,
  type RunId,
  type ToolCallStatus,
  type ToolCardEnd,
  type LogLevel,
  type MessageType,
  type ProcessOutputStream,
  type ToolUseLog,
} from '@shared/schemas';
import type { LogOptions } from '@shared/schemas/logPayload';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import type { AgentEvent } from '@shared/session/agentEvent';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateSummary } from '@utils/text/stringUtils';

import type {
  AgentTrace,
  AgentTraceSink,
  StreamHandle,
  ToolCardHandle,
} from './AgentTrace';

const CHANNEL = 'TraceEmitter';

export class TraceEmitter implements AgentTrace {
  /** The sink this trace was built with; null once it closed. */
  private sink: AgentTraceSink | null;

  constructor(sink: AgentTraceSink) {
    this.sink = sink;
  }

  // ─── SSoT primitives ───────────────────────────────────────────────

  /** End the trace with its run: an event emitted after this reaches no
   *  sink, since the run it would describe has ended. */
  close(): void {
    this.sink = null;
  }

  emit(event: AgentEvent): void {
    if (this.sink === null) return;
    try {
      this.sink(event);
    } catch (err) {
      // A misbehaving sink must not break the run. Write the entry to the
      // host log sink directly (not back through this emitter, and not
      // through a fiber: `emit` is the trace's one synchronous publication
      // point) so a throwing sink is diagnosable without recursing into the
      // trace stream, at `warn`: a sink fault swallowed at `debug` would
      // degrade silently.
      writeLogLine(
        CHANNEL,
        `Trace sink threw while handling event: ${toErrorMessage(err)}`,
      );
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

  /** A chunk of a process run's output, on its stream. */
  output(stream: ProcessOutputStream, text: string): void {
    this.emit({ type: 'process.output', stream, text });
  }

  error(message: string, options: LogOptions = {}): void {
    this.emitLog('error', message, options);
  }

  private emitLog(level: LogLevel, message: string, options: LogOptions): void {
    this.emit({
      type: 'log',
      level,
      message,
      // JSON RPC encodes an explicit undefined as null, a different payload.
      ...(options.data === undefined
        ? {}
        : { data: toJsonValue(raisedBy(options.data)) }),
      messageType: options.messageType,
    });
  }

  // ─── Stages ────────────────────────────────────────────────────────

  stage<A, E, R>(
    label: string,
    use: (trace: AgentTrace) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const id = crypto.randomUUID();
        this.emit({ type: 'stage.start', id, label });
        return id;
      }),
      // A chunk is transient text on its row's id, which carries the stage;
      // an event a nested stage stamped keeps its own (a nested stage's
      // `stage.start`/`stage.end` carry this one's id, their parent).
      (id) =>
        use(
          new TraceEmitter((event) =>
            this.emit(
              event.type === 'stream.chunk' || event.stageId !== undefined
                ? event
                : { ...event, stageId: id },
            ),
          ),
        ),
      (id, exit) =>
        Effect.sync(() =>
          this.emit({
            type: 'stage.end',
            id,
            status: Exit.isSuccess(exit)
              ? RUN_OUTCOME.COMPLETED
              : outcomeFromCause(exit.cause),
          }),
        ),
    );
  }

  // ─── Streams ───────────────────────────────────────────────────────

  openStream(kind: MessageType): StreamHandle {
    const id = crypto.randomUUID();
    return new StreamHandleImpl(this, id, () =>
      this.emit({ type: 'stream.start', id, kind }),
    );
  }

  // ─── Tool cards ────────────────────────────────────────────────────

  openToolCard(log: ToolUseLog): ToolCardHandle {
    const logId = crypto.randomUUID();
    this.emit({
      type: 'tool.start',
      logId,
      toolName: log.toolName,
      input: toJsonValue(log.input),
      ...(log.card ? { card: log.card } : {}),
    });
    if (log.status === undefined || log.status === 'in_progress')
      return new ToolCardHandleImpl(this, logId, log, true);
    this.emit({ type: 'tool.end', logId, ...cardEnd(log, log.status) });
    return new ToolCardHandleImpl(this, logId, log, false);
  }
}

/**
 * What a card's tool stated, as its `tool.end` stores it: parsed once here,
 * where a plugin's log enters the trace, with its input and output as JSON
 * and no status (the row states it). A log the schema rejects (a plugin's
 * JavaScript is not held to its types) never throws out of the plugin's
 * call: it is logged at warn and the card keeps its name and input, with a
 * bounded diagnostic naming the invalid fields, never their values, as its
 * error; it reads failed unless it says it is still running.
 */
function cardEnd(
  { status: _status, ...log }: ToolUseLog,
  status: ToolCallStatus,
): { readonly status: ToolCallStatus; readonly log: ToolCardEnd } {
  const json = toJsonValue(log);
  const decoded = Schema.decodeUnknownResult(ToolCardEndSchema)(json);
  if (Result.isSuccess(decoded)) return { status, log: decoded.success };
  const fields = [
    ...new Set(
      formatIssuesForDiagnostics(decoded.failure)
        .map((issue) => issue.path)
        .filter((path) => path.length > 0),
    ),
  ];
  const error = truncateSummary(
    `Malformed tool payload (${fields.length > 0 ? `invalid ${fields.join(', ')}` : 'unparseable payload'})`,
    160,
  );
  const toolName = typeof log.toolName === 'string' ? log.toolName : '';
  writeLogLine(CHANNEL, `Tool card of "${toolName}" rejected: ${error}`);
  return {
    status: status === 'in_progress' ? status : 'failed',
    log: {
      toolName,
      ...(log.input === undefined ? {} : { input: toJsonValue(log.input) }),
      error,
    },
  };
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
    const status = log.status ?? 'completed';
    this.log = log;
    this.open = status === 'in_progress';
    this.trace.emit({
      type: 'tool.end',
      logId: this.logId,
      ...cardEnd(log, status),
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

class StreamHandleImpl implements StreamHandle {
  // Chunks are buffered in an array and joined once at finalize so a long
  // stream costs O(n) instead of repeated full-buffer string copies.
  private readonly chunks: string[] = [];
  private finalText: string | undefined;

  private readonly trace: TraceEmitter;
  readonly id: string;
  /**
   * The `stream.start` emission, waiting for content (`openStream`); null once
   * started. A stream finalized without content emits no events at all,
   * while a finalize that carries text emits the start/end pair so
   * reasoning that only arrives in the final response still lands as a
   * single entry.
   */
  private pendingStart: (() => void) | null;
  constructor(trace: TraceEmitter, id: string, pendingStart: () => void) {
    this.trace = trace;
    this.id = id;
    this.pendingStart = pendingStart;
  }

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
    // Not started and nothing to say: the phase never happened, so the
    // stream leaves no trace at all.
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
  return { ...event, aggregateId: runId };
}

/**
 * The model's answer text out of a run's events, chunk by chunk as it
 * streams: `run.events.pipe(responseText)`.
 *
 * A `stream.chunk` names only its stream, and a run streams more than its
 * answer: the model's thinking and what a running tool prints are chunks
 * too. This keeps the chunks of the streams that opened as a model response
 * and drops the rest. A response that arrives whole, with no chunks (a
 * background or non-streaming model call), comes out as its `stream.end`'s
 * final text. A model call that fails and is retried has already streamed
 * its partial answer; the retry's answer follows it.
 */
export const responseText = <E, R>(
  events: Stream.Stream<AgentEvent, E, R>,
): Stream.Stream<string, E, R> =>
  events.pipe(
    Stream.mapAccum(
      // Each open response stream, and whether it has streamed a chunk.
      () => new Map<string, boolean>(),
      (answers, event): readonly [Map<string, boolean>, readonly string[]] => {
        switch (event.type) {
          case 'stream.start':
            if (event.kind === MESSAGE_TYPES.MODEL_RESPONSE)
              answers.set(event.id, false);
            return [answers, []];
          case 'stream.chunk':
            if (!answers.has(event.id)) return [answers, []];
            answers.set(event.id, true);
            return [answers, [event.text]];
          case 'stream.end': {
            const streamed = answers.get(event.id);
            answers.delete(event.id);
            return [
              answers,
              streamed === false && event.finalText ? [event.finalText] : [],
            ];
          }
          default:
            return [answers, []];
        }
      },
    ),
  );
