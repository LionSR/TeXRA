// Standard library imports
import { AsyncLocalStorage } from 'node:async_hooks';

// Local imports - shared schemas
import type { LogLevel, StreamTabId } from '@shared/schemas';

export interface LogFields {
  readonly streamId?: StreamTabId;
  readonly runId?: string;
  readonly groupId?: string;
  readonly [key: string]: unknown;
}

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
  readonly groups: readonly string[];
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  activeGroupId(): string | undefined;
  group(label: string): () => void;
  withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  child(fields: LogFields): Logger;
  swapSink(next: LogSink): Promise<void>;
}

interface SinkRef {
  current: LogSink;
}

type GroupContextKey = symbol;

const activeGroupStacks = new AsyncLocalStorage<
  Map<GroupContextKey, string[]>
>();

export function createStructuredLogger(sink: LogSink): Logger {
  return new StructuredLogger({
    sinkRef: { current: sink },
    groupContextKey: Symbol('structuredLoggerGroupContext'),
  });
}

function mergeFields(left: LogFields, right: LogFields | undefined): LogFields {
  return right ? { ...left, ...right } : left;
}

function cloneGroupStacks(
  stacks: Map<GroupContextKey, string[]> | undefined,
): Map<GroupContextKey, string[]> {
  const next = new Map<GroupContextKey, string[]>();
  if (stacks) {
    for (const [key, groups] of stacks) next.set(key, [...groups]);
  }
  return next;
}

class StructuredLogger implements Logger {
  private readonly groupStack: string[];

  constructor(
    private readonly context: {
      readonly sinkRef: SinkRef;
      readonly groupContextKey: GroupContextKey;
    },
    private readonly fields: LogFields = {},
    groupStack: string[] = [],
  ) {
    this.groupStack = groupStack;
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  activeGroupId(): string | undefined {
    return this.currentGroups().at(-1);
  }

  group(label: string): () => void {
    return this.enterGroup(label, true);
  }

  async withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const parentGroups = this.currentGroups();
    const parentStacks = activeGroupStacks.getStore();
    const nextStacks = cloneGroupStacks(parentStacks);
    nextStacks.set(this.context.groupContextKey, [...parentGroups, label]);
    try {
      return await activeGroupStacks.run(nextStacks, fn);
    } finally {
      await this.context.sinkRef.current.flush?.();
    }
  }

  private enterGroup(label: string, flushOnPop: boolean): () => void {
    const activeStack = activeGroupStacks
      .getStore()
      ?.get(this.context.groupContextKey);
    const groups = activeStack ?? this.groupStack;
    const index = groups.length;
    groups.push(label);
    let popped = false;
    return () => {
      if (popped) return;
      popped = true;
      if (groups[index] === label) {
        groups.splice(index, 1);
      } else {
        const currentIndex = groups.lastIndexOf(label);
        if (currentIndex >= 0) groups.splice(currentIndex, 1);
      }
      if (flushOnPop) {
        const flush = this.context.sinkRef.current.flush?.();
        if (flush) void flush.catch(() => undefined);
      }
    };
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(
      this.context,
      mergeFields(this.fields, fields),
      this.groupStack,
    );
  }

  async swapSink(next: LogSink): Promise<void> {
    const previous = this.context.sinkRef.current;
    await previous.flush?.();
    await previous.close?.();
    this.context.sinkRef.current = next;
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    this.context.sinkRef.current.write({
      ts: new Date().toISOString(),
      level,
      message,
      fields: mergeFields(this.fields, fields),
      groups: [...this.currentGroups()],
    });
  }

  private currentGroups(): readonly string[] {
    return (
      activeGroupStacks.getStore()?.get(this.context.groupContextKey) ??
      this.groupStack
    );
  }
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}
