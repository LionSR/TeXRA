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

function mergeFields(left: LogFields, right: LogFields | undefined): LogFields {
  return right ? { ...left, ...right } : left;
}

export class StructuredLogger implements Logger {
  private readonly groupStack: string[];
  private readonly sinkRef: SinkRef;

  constructor(
    sink: LogSink,
    private readonly fields: LogFields = {},
    groupStack: readonly string[] = [],
    sinkRef?: SinkRef,
  ) {
    this.groupStack = [...groupStack];
    this.sinkRef = sinkRef ?? { current: sink };
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
    this.groupStack.push(label);
    let popped = false;
    return () => {
      if (popped) return;
      popped = true;
      this.groupStack.pop();
      void this.sinkRef.current.flush?.();
    };
  }

  async withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const pop = this.group(label);
    try {
      return await fn();
    } finally {
      pop();
      await this.sinkRef.current.flush?.();
    }
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(
      this.sinkRef.current,
      mergeFields(this.fields, fields),
      this.groupStack,
      this.sinkRef,
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
