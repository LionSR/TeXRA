/**
 * Minimal structured logger for the CLI runtime.
 *
 * Builds {@link LogRecord}s and writes them to a {@link LogSink}. That is
 * the entire job — the CLI uses one of these to format every progress event
 * as either NDJSON or human-readable text on stdout/stderr.
 *
 * Group-context tracking and child-logger field inheritance used to live
 * here but were redundant once the {@link AgentTrace} channel took over
 * stage-context responsibility. They have been removed.
 */
import type { LogLevel } from '@shared/schemas';

export interface LogFields {
  readonly streamId?: string;
  readonly runId?: string;
  readonly groupId?: string;
  readonly [key: string]: unknown;
}

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
  /**
   * Always empty in the simplified logger — retained on the record shape
   * so CLI sinks (`StderrTextSink`, `NdjsonStdoutSink`) that read
   * `record.groups` don't have to change.
   */
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
}

const EMPTY_GROUPS: readonly string[] = Object.freeze([]);

export function createStructuredLogger(sink: LogSink): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    sink.write({
      ts: new Date().toISOString(),
      level,
      message,
      fields: fields ?? {},
      groups: EMPTY_GROUPS,
    });
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
