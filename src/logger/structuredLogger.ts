import { AsyncLocalStorage } from 'node:async_hooks';

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
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  activeGroupId(): string | undefined;
  withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  child(fields: LogFields): Logger;
}

type GroupContextKey = symbol;

const activeGroupStacks = new AsyncLocalStorage<
  Map<GroupContextKey, string[]>
>();

export function createStructuredLogger(sink: LogSink): Logger {
  return new StructuredLogger({
    sink,
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
  constructor(
    private readonly context: {
      readonly sink: LogSink;
      readonly groupContextKey: GroupContextKey;
    },
    private readonly fields: LogFields = {},
  ) {}

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

  async withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const parentGroups = this.currentGroups();
    const parentStacks = activeGroupStacks.getStore();
    const nextStacks = cloneGroupStacks(parentStacks);
    nextStacks.set(this.context.groupContextKey, [...parentGroups, label]);
    try {
      return await activeGroupStacks.run(nextStacks, fn);
    } finally {
      await this.context.sink.flush?.();
    }
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(this.context, mergeFields(this.fields, fields));
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    this.context.sink.write({
      ts: new Date().toISOString(),
      level,
      message,
      fields: mergeFields(this.fields, fields),
      groups: [...this.currentGroups()],
    });
  }

  private currentGroups(): readonly string[] {
    return (
      activeGroupStacks.getStore()?.get(this.context.groupContextKey) ?? []
    );
  }
}
