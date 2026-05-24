/**
 * Default in-process implementation of {@link AgentTrace}.
 *
 * This is the agent-general core: no MESSAGE_TYPES, no TeXRA-specific
 * sugar. Hosts that need product-specific helpers extend this class
 * (see `TexraTraceEmitter` in `@logger/TexraTraceEmitter`).
 *
 * Responsibilities at the emit boundary (one place, not many):
 *   - stamp `stageId` from the AsyncLocalStorage scope
 *   - fan out to subscribers
 *   - swallow per-subscriber exceptions so one bad sink can't break the run
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { END_GROUP_STATUS, type EndGroupStatus } from '@shared/schemas';

import type {
  AgentEvent,
  ContextStateData,
  StreamKind,
  TokenUsageStats,
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
} from './AgentTrace';

const stageScope = new AsyncLocalStorage<string[]>();

function currentStageStack(): string[] {
  return stageScope.getStore() ?? [];
}

export class TraceEmitter implements AgentTrace {
  private readonly subscribers = new Set<AgentTraceSubscriber>();

  // ─── SSoT primitives ───────────────────────────────────────────────

  subscribe(subscriber: AgentTraceSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: AgentEvent): void {
    // Single resolve point — stage stamp wins from the event itself if
    // the caller supplied one; otherwise fall back to the active scope.
    const stamped: AgentEvent =
      event.stageId !== undefined
        ? event
        : ({ ...event, stageId: currentStageStack().at(-1) } as AgentEvent);

    for (const sub of this.subscribers) {
      try {
        sub(stamped);
      } catch {
        // A misbehaving subscriber must not break the run.
      }
    }
  }

  activeStageId(): string | undefined {
    return currentStageStack().at(-1);
  }

  withStage<T>(
    stageId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!stageId) return Promise.resolve(fn());
    const nextStack = [...currentStageStack(), stageId];
    return stageScope.run(nextStack, () => Promise.resolve(fn()));
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

  usage(stats: TokenUsageStats, options: StagedEmitOptions = {}): void {
    this.emit({ type: 'usage', stats, stageId: options.stageId });
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

  // ─── Stages ────────────────────────────────────────────────────────

  openStage(label: string, options: StageOptions = {}): StageHandle {
    const defaultStatus = options.defaultStatus ?? END_GROUP_STATUS.STOPPED;
    const parentId = options.root
      ? undefined
      : (options.parent?.id ?? options.parentId ?? this.activeStageId());

    if (options.skip) {
      return new SkippedStageHandle(this, parentId);
    }

    const id = options.id ?? randomUUID();
    this.emit({ type: 'stage.start', id, label, parentId });
    return new StageHandleImpl(this, id, defaultStatus);
  }

  // ─── Streams ───────────────────────────────────────────────────────

  openStream(kind: StreamKind, options: StreamOptions = {}): StreamHandle {
    const id = options.id ?? randomUUID();
    const progressEnabled = options.progressViewEnabled ?? true;

    if (!progressEnabled) {
      // Local-only buffering — chunks never emit. `finalize` returns the
      // text but nothing reaches subscribers.
      return new BufferOnlyStreamHandle(this, id);
    }

    // Open inside the explicit stage scope so the start event carries the
    // right stageId without forcing the caller to await.
    if (options.stageId && options.stageId !== this.activeStageId()) {
      const nextStack = [...currentStageStack(), options.stageId];
      let handle!: StreamHandle;
      stageScope.run(nextStack, () => {
        this.emit({ type: 'stream.start', id, kind });
        handle = new StreamHandleImpl(this, id);
      });
      return handle;
    }

    this.emit({ type: 'stream.start', id, kind });
    return new StreamHandleImpl(this, id);
  }
}

class StageHandleImpl implements StageHandle {
  private ended = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
    private readonly defaultStatus: EndGroupStatus,
  ) {}

  end(status?: EndGroupStatus): void {
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
      this.end(this.defaultStatus);
      return result;
    } catch (err) {
      this.end(END_GROUP_STATUS.ERROR);
      throw err;
    }
  }

  child(label: string, options: StageOptions = {}): StageHandle {
    return this.trace.openStage(label, { ...options, parent: this });
  }
}

/** Stage handle used when `skip: true` — propagates parent context but emits nothing. */
class SkippedStageHandle implements StageHandle {
  readonly id: string | undefined;

  constructor(
    private readonly trace: TraceEmitter,
    private readonly parentId: string | undefined,
  ) {
    this.id = undefined;
  }

  end(_status?: EndGroupStatus): void {
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
  private buffer = '';
  private finalized = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
  ) {}

  append(text: string): void {
    if (this.finalized || !text) return;
    this.buffer += text;
    this.trace.emit({ type: 'stream.chunk', id: this.id, text });
  }

  finalize(finalText?: string): string {
    if (this.finalized) return this.buffer;
    this.finalized = true;
    if (typeof finalText === 'string') this.buffer = finalText;
    this.trace.emit({
      type: 'stream.end',
      id: this.id,
      finalText: typeof finalText === 'string' ? finalText : undefined,
    });
    return this.buffer;
  }
}

/**
 * Local-buffer-only stream — used when `progressViewEnabled: false`.
 * Chunks never reach subscribers; `finalize` returns the accumulated text
 * so callers can still read it back.
 */
class BufferOnlyStreamHandle implements StreamHandle {
  private buffer = '';
  private finalized = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
  ) {}

  append(text: string): void {
    if (this.finalized || !text) return;
    this.buffer += text;
  }

  finalize(finalText?: string): string {
    if (this.finalized) return this.buffer;
    this.finalized = true;
    if (typeof finalText === 'string') this.buffer = finalText;
    return this.buffer;
  }
}
