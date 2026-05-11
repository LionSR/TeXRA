// Local imports - logger
import type { LogRecord, LogSink } from '@logger/structuredLogger';

let stdoutClosed = false;
let stderrClosed = false;

function isClosedStreamError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')
  );
}

function writeLine(
  stream: NodeJS.WriteStream,
  text: string,
  streamClosed: () => boolean,
  markClosed: () => void,
): void {
  if (streamClosed() || stream.destroyed) return;
  try {
    stream.write(`${text}\n`, (error) => {
      if (!error) return;
      if (isClosedStreamError(error)) {
        markClosed();
        return;
      }
      throw error;
    });
  } catch (error) {
    if (isClosedStreamError(error)) {
      markClosed();
      return;
    }
    throw error;
  }
}

export function writeNdjsonStdout(record: unknown): void {
  writeLine(
    process.stdout,
    JSON.stringify(record),
    () => stdoutClosed,
    () => {
      stdoutClosed = true;
    },
  );
}

export function writeTextStdout(text: string): void {
  writeLine(
    process.stdout,
    text,
    () => stdoutClosed,
    () => {
      stdoutClosed = true;
    },
  );
}

export function writeTextStderr(text: string): void {
  writeLine(
    process.stderr,
    text,
    () => stderrClosed,
    () => {
      stderrClosed = true;
    },
  );
}

export class StderrTextSink implements LogSink {
  write(record: LogRecord): void {
    const groups = record.groups.length
      ? ` [${record.groups.join(' > ')}]`
      : '';
    const stream = record.fields.streamId ? ` [${record.fields.streamId}]` : '';
    writeTextStderr(
      `${record.ts} ${record.level.toUpperCase()}${stream}${groups} ${record.message}`,
    );
  }
}

export class NdjsonStdoutSink implements LogSink {
  private readonly queue: LogRecord[] = [];
  private drainPromise: Promise<void> | undefined;
  private stdoutClosed = false;

  write(record: LogRecord): void {
    this.queue.push(record);
    void this.ensureDrain().catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.ensureDrain();
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private ensureDrain(): Promise<void> {
    this.drainPromise ??= this.drain();
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stdoutClosed && this.queue.length > 0) {
        const record = this.queue.shift();
        if (!record) continue;
        const line = `${JSON.stringify({ kind: 'log', ...record })}\n`;
        let canContinue: boolean;
        try {
          canContinue = process.stdout.write(line);
        } catch {
          this.stdoutClosed = true;
          this.queue.length = 0;
          return;
        }
        if (!canContinue && !(await this.waitForStdoutDrain())) {
          this.stdoutClosed = true;
          this.queue.length = 0;
          return;
        }
      }
    } finally {
      this.drainPromise = undefined;
      if (this.queue.length > 0) {
        void this.ensureDrain().catch(() => undefined);
      }
    }
  }

  private waitForStdoutDrain(): Promise<boolean> {
    if (process.stdout.destroyed) return Promise.resolve(false);
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
        process.stdout.off('drain', onDrain);
        process.stdout.off('error', onClosed);
        process.stdout.off('close', onClosed);
      };
      process.stdout.once('drain', onDrain);
      process.stdout.once('error', onClosed);
      process.stdout.once('close', onClosed);
    });
  }
}
