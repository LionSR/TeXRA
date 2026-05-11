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
  group(label: string): () => void;
  withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  child(fields: LogFields): Logger;
  swapSink(next: LogSink): Promise<void>;
}

interface SinkRef {
  current: LogSink;
}

interface GroupQueue {
  tail: Promise<void>;
}

export function createStructuredLogger(sink: LogSink): Logger {
  return new StructuredLogger({ current: sink });
}

function mergeFields(left: LogFields, right: LogFields | undefined): LogFields {
  return right ? { ...left, ...right } : left;
}

class StructuredLogger implements Logger {
  private readonly groupStack: string[];

  constructor(
    private readonly sinkRef: SinkRef,
    private readonly fields: LogFields = {},
    groupStack: string[] = [],
    private readonly groupQueue: GroupQueue = { tail: Promise.resolve() },
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

  group(label: string): () => void {
    return this.enterGroup(label, true);
  }

  async withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const previousGroup = this.groupQueue.tail.catch(() => undefined);
    let releaseGroup: () => void = () => undefined;
    this.groupQueue.tail = previousGroup.then(
      () =>
        new Promise<void>((resolve) => {
          releaseGroup = resolve;
        }),
    );
    await previousGroup;

    const pop = this.enterGroup(label, false);
    try {
      return await fn();
    } finally {
      pop();
      releaseGroup();
      await this.sinkRef.current.flush?.();
    }
  }

  private enterGroup(label: string, flushOnPop: boolean): () => void {
    const index = this.groupStack.length;
    this.groupStack.push(label);
    let popped = false;
    return () => {
      if (popped) return;
      popped = true;
      if (this.groupStack[index] === label) {
        this.groupStack.splice(index, 1);
      } else {
        const currentIndex = this.groupStack.lastIndexOf(label);
        if (currentIndex >= 0) this.groupStack.splice(currentIndex, 1);
      }
      if (flushOnPop) {
        const flush = this.sinkRef.current.flush?.();
        if (flush) void flush.catch(() => undefined);
      }
    };
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(
      this.sinkRef,
      mergeFields(this.fields, fields),
      [...this.groupStack],
      this.groupQueue,
    );
  }

  async swapSink(next: LogSink): Promise<void> {
    const previous = this.sinkRef.current;
    await previous.flush?.();
    await previous.close?.();
    this.sinkRef.current = next;
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    this.sinkRef.current.write({
      ts: new Date().toISOString(),
      level,
      message,
      fields: mergeFields(this.fields, fields),
      groups: [...this.groupStack],
    });
  }
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}
