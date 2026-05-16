// Standard library imports
import { createInterface } from 'node:readline/promises';

// Local imports - logger
import type { LogRecord, LogSink } from '@logger/structuredLogger';

const closed = { stdout: false, stderr: false };

type StreamKey = 'stdout' | 'stderr';

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

export function writeNdjsonStdout(record: unknown): void {
  writeRaw('stdout', `${JSON.stringify(record)}\n`);
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

export async function askCliQuestion(question: string): Promise<string> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

export function createCliLineReader(
  prompt: string,
): ReturnType<typeof createInterface> {
  return createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt,
  });
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
      if (!this.stdoutClosed && this.queue.length > 0) {
        this.drainPromise = this.drain();
        await this.drainPromise;
      } else {
        this.drainPromise = undefined;
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
