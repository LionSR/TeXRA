// Node imports
import { createInterface } from 'node:readline/promises';

// Local imports
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import type { LogLevel } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Minimal structured-log primitives. The CLI uses these to format every
 * progress event as either NDJSON or human-readable text on stdout/stderr.
 * Previously lived in `@logger/structuredLogger`; inlined here because the
 * CLI is the only consumer.
 */
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

export function createCliLogger(sink: LogSink): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void =>
    sink.write({
      ts: new Date().toISOString(),
      level,
      message,
      fields: fields ?? {},
    });
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

const closed = { stdout: false, stderr: false };

type StreamKey = 'stdout' | 'stderr';

export function isCliPipeClosureError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

let pipeErrorHandlersInstalled = false;

export function installCliPipeErrorHandlers(): void {
  if (pipeErrorHandlersInstalled) return;
  pipeErrorHandlersInstalled = true;

  for (const key of ['stdout', 'stderr'] as const) {
    process[key].on('error', (error) => {
      if (isCliPipeClosureError(error)) {
        closed[key] = true;
        return;
      }
      throw error;
    });
  }
}

// CLI output is best effort: throwing from an async write callback would bypass
// the command error boundary and can crash the process.
function writeRaw(key: StreamKey, text: string): void {
  if (closed[key]) return;
  const stream = process[key];
  if (stream.destroyed) return;
  try {
    stream.write(text, (error) => {
      if (error) closed[key] = true;
    });
  } catch {
    closed[key] = true;
  }
}

function writeRawAndWait(key: StreamKey, text: string): Promise<void> {
  if (closed[key]) return Promise.resolve();
  const stream = process[key];
  if (stream.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      stream.write(text, (error) => {
        if (error) closed[key] = true;
        resolve();
      });
    } catch {
      closed[key] = true;
      resolve();
    }
  });
}

export function writeTextStdout(text: string): void {
  writeRaw('stdout', `${text}\n`);
}

export function writeRawStdout(text: string): void {
  writeRaw('stdout', text);
}

export function writeRawStderr(text: string): void {
  writeRaw('stderr', text);
}

export function writeTextStderr(text: string): void {
  writeRaw('stderr', `${text}\n`);
}

export function writeTextStdoutAndWait(text: string): Promise<void> {
  return writeRawAndWait('stdout', `${text}\n`);
}

export function writeTextStderrAndWait(text: string): Promise<void> {
  return writeRawAndWait('stderr', `${text}\n`);
}

/**
 * Write a caught error's human-readable message to stderr. Folds the
 * `writeTextStderr(toErrorMessage(error))` pair every command's catch block
 * repeated so the error-formatting choice lives in one place.
 */
export function writeErrorStderr(error: unknown): void {
  writeTextStderr(toErrorMessage(error));
}

export async function askCliQuestion(
  question: string,
  input: NodeJS.ReadableStream & { ref?: () => void } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  // Ink releases its ownership of stdin with `unref()` when a TUI exits.
  // A following readline prompt must acquire its own live handle or Node can
  // terminate while the top-level command is still awaiting the answer.
  input.ref?.();
  const prompt = createInterface({
    input,
    output,
  });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

class StderrTextSink implements LogSink {
  write(record: LogRecord): void {
    const stream = record.fields.streamId ? ` [${record.fields.streamId}]` : '';
    writeTextStderr(
      `${record.ts} ${record.level.toUpperCase()}${stream} ${record.message}`,
    );
  }
}

interface NdjsonWritable {
  /**
   * False once the target can no longer accept writes. The target owns this
   * answer so the sink never has to ask whether it happens to be holding
   * `process.stdout` and consult the module-level pipe-closure flag itself.
   */
  readonly usable: boolean;
  write(text: string): boolean;
  once(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'error' | 'close', listener: () => void): unknown;
}

const processStdoutTarget: NdjsonWritable = {
  get usable(): boolean {
    return !process.stdout.destroyed && !closed.stdout;
  },
  write: (text) => process.stdout.write(text),
  once: (event, listener) => process.stdout.once(event, listener),
  off: (event, listener) => process.stdout.off(event, listener),
};

export class NdjsonStdoutSink implements LogSink {
  private readonly queue: CliNdjsonRecord[] = [];
  private drainPromise: Promise<void> | undefined;
  private stdoutClosed = false;

  constructor(private readonly stdout: NdjsonWritable = processStdoutTarget) {}

  write(record: LogRecord): void {
    this.writeRecord({ kind: 'log', ...record });
  }

  writeRecord(record: CliNdjsonRecord): void {
    if (this.isClosed()) return;
    this.queue.push(record);
    void this.ensureDrain().catch(() => undefined);
  }

  async flush(): Promise<void> {
    while (this.drainPromise || this.queue.length > 0) {
      await (this.drainPromise ?? this.ensureDrain());
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private ensureDrain(): Promise<void> {
    if (!this.drainPromise) {
      const promise = this.drain();
      this.drainPromise = promise;
      void promise.finally(() => {
        if (this.drainPromise === promise) {
          this.drainPromise = undefined;
        }
        if (!this.stdoutClosed && this.queue.length > 0) {
          void this.ensureDrain().catch(() => undefined);
        }
      });
    }
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    if (this.isClosed()) {
      this.closeQueue();
      return;
    }
    while (!this.isClosed() && this.queue.length > 0) {
      const record = this.queue.shift();
      if (!record) continue;
      const line = `${JSON.stringify(record)}\n`;
      let canContinue: boolean;
      try {
        canContinue = this.stdout.write(line);
      } catch {
        this.closeQueue();
        return;
      }
      if (!canContinue && !(await this.waitForStdoutDrain())) {
        this.closeQueue();
        return;
      }
    }
  }

  private isClosed(): boolean {
    return this.stdoutClosed || !this.stdout.usable;
  }

  private closeQueue(): void {
    this.stdoutClosed = true;
    this.queue.length = 0;
  }

  private waitForStdoutDrain(): Promise<boolean> {
    if (!this.stdout.usable) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let cleanup = (): void => undefined;
      const onDrain = (): void => {
        cleanup();
        resolve(true);
      };
      const onClosed = (): void => {
        cleanup();
        resolve(false);
      };
      cleanup = (): void => {
        this.stdout.off('drain', onDrain);
        this.stdout.off('error', onClosed);
        this.stdout.off('close', onClosed);
      };
      this.stdout.once('drain', onDrain);
      this.stdout.once('error', onClosed);
      this.stdout.once('close', onClosed);
    });
  }
}

const ndjsonStdoutSink = new NdjsonStdoutSink();

/** Queue one public NDJSON record on the process-wide stdout serializer. */
export function writeNdjsonStdout(record: CliNdjsonRecord): void {
  ndjsonStdoutSink.writeRecord(record);
}

/** Wait until all queued public NDJSON and structured log records are written. */
export function flushNdjsonStdout(): Promise<void> {
  return ndjsonStdoutSink.flush();
}

// CLI logs to stdout/stderr are not redacted — operators are expected to
// inspect their own terminals. Desktop logs (which can be exported and shared)
// are redacted in `desktopAppLog.ts` via the shared `redactSecrets` helper.
export function createCliLogSink(format: string): LogSink {
  return format === 'ndjson' ? ndjsonStdoutSink : new StderrTextSink();
}
