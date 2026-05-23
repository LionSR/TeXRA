/**
 * Default in-process implementation of AgentTrace.
 *
 * Responsibilities at the emit boundary (one place, not 10):
 *   - stamp `stageId` from the AsyncLocalStorage scope
 *   - fan out to subscribers
 *   - swallow per-subscriber exceptions so one bad sink can't break the run
 *
 * Stateful handles (StageHandle / StreamHandle) are implemented in terms of
 * `emit()` so adding a new event arm forces an exhaustive-switch error in
 * every subscriber and nothing else.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { END_GROUP_STATUS, type EndGroupStatus } from '@shared/schemas';

import type {
  AgentEvent,
  ContextStateData,
  FilesLoadedEvent,
  StreamKind,
  TokenUsageStats,
  ToolStatus,
} from './events';
import type {
  AgentTrace,
  AgentTraceSubscriber,
  DomainEventInput,
  LogOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
} from './AgentTrace';

const stageScope = new AsyncLocalStorage<string[]>();

/**
 * Returns the active stage id from the current AsyncLocalStorage scope.
 *
 * Stage stacks are duplicated on push so nested `within` invocations don't
 * mutate a parent scope's array.
 */
function currentStageStack(): string[] {
  return stageScope.getStore() ?? [];
}

export class TraceEmitter implements AgentTrace {
  private readonly subscribers = new Set<AgentTraceSubscriber>();

  subscribe(subscriber: AgentTraceSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: AgentEvent): void {
    // Stage stamp wins from the event itself if the caller supplied one
    // (e.g. an explicit groupId from a deferred tool); otherwise fall back
    // to the active scope. This is the single resolve point.
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

  /**
   * Run `fn` with `stageId` pushed onto the active stage stack. Used when
   * resuming a stage opened elsewhere (e.g. deferred tools or external
   * callers passing an explicit groupId).
   *
   * If `stageId` is undefined the call is a passthrough so callers don't
   * have to branch on optional ids.
   */
  withStage<T>(
    stageId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!stageId) return Promise.resolve(fn());
    const nextStack = [...currentStageStack(), stageId];
    return stageScope.run(nextStack, () => Promise.resolve(fn()));
  }

  debug(message: string, options: LogOptions = {}): void {
    this.emit({
      type: 'log',
      level: 'debug',
      message,
      data: options.data,
      messageType: options.messageType,
      verbose: options.verbose,
    });
  }

  info(message: string, options: LogOptions = {}): void {
    this.emit({
      type: 'log',
      level: 'info',
      message,
      data: options.data,
      messageType: options.messageType,
      verbose: options.verbose,
    });
  }

  warn(message: string, options: LogOptions = {}): void {
    this.emit({
      type: 'log',
      level: 'warn',
      message,
      data: options.data,
      messageType: options.messageType,
      verbose: options.verbose,
    });
  }

  error(message: string, options: LogOptions = {}): void {
    this.emit({
      type: 'log',
      level: 'error',
      message,
      data: options.data,
      messageType: options.messageType,
      verbose: options.verbose,
    });
  }

  usage(stats: TokenUsageStats): void {
    this.emit({ type: 'usage', stats });
  }

  contextState(snapshot: ContextStateData): void {
    this.emit({
      type: 'context.state',
      inputTokens: snapshot.inputTokens,
      contextWindow: snapshot.contextWindow,
    });
  }

  filesLoaded(input: Omit<FilesLoadedEvent, 'type' | 'stageId'>): void {
    this.emit({
      type: 'files.loaded',
      category: input.category,
      entries: input.entries,
    });
  }

  toolStart(input: {
    logId: string;
    toolName: string;
    input: unknown;
  }): void {
    this.emit({
      type: 'tool.start',
      logId: input.logId,
      toolName: input.toolName,
      input: input.input,
    });
  }

  toolEnd(input: {
    logId: string;
    status: ToolStatus;
    result?: unknown;
  }): void {
    this.emit({
      type: 'tool.end',
      logId: input.logId,
      status: input.status,
      result: input.result,
    });
  }

  domain(input: DomainEventInput): void {
    this.emit({
      type: 'domain',
      key: input.key,
      data: input.data,
      text: input.text,
    });
  }

  openStage(label: string, options: StageOptions = {}): StageHandle {
    const id = options.id ?? randomUUID();
    const parentId = options.parentId ?? this.activeStageId();
    const defaultStatus = options.defaultStatus ?? END_GROUP_STATUS.STOPPED;

    this.emit({ type: 'stage.start', id, label, parentId });
    return new StageHandleImpl(this, id, defaultStatus);
  }

  openStream(kind: StreamKind, options: StreamOptions = {}): StreamHandle {
    const id = options.id ?? randomUUID();
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
    const nextStack = [...currentStageStack(), this.id];
    return stageScope.run(nextStack, () => Promise.resolve(fn()));
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
    return this.trace.openStage(label, { ...options, parentId: this.id });
  }
}

class StreamHandleImpl implements StreamHandle {
  private finalized = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
  ) {}

  append(text: string): void {
    if (this.finalized || !text) return;
    this.trace.emit({ type: 'stream.chunk', id: this.id, text });
  }

  finalize(finalText?: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.trace.emit({ type: 'stream.end', id: this.id, finalText });
  }
}
