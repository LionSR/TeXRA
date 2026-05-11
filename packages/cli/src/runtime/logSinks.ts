// Local imports - logger
import type { LogRecord, LogSink } from '@logger/structuredLogger';

export function writeNdjsonStdout(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function writeTextStdout(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeTextStderr(text: string): void {
  process.stderr.write(`${text}\n`);
}

export class StderrTextSink implements LogSink {
  write(record: LogRecord): void {
    const groups = record.groups.length
      ? ` [${record.groups.join(' > ')}]`
      : '';
    const stream = record.fields.streamId ? ` [${record.fields.streamId}]` : '';
    process.stderr.write(
      `${record.ts} ${record.level.toUpperCase()}${stream}${groups} ${record.message}\n`,
    );
  }
}

export class NdjsonStdoutSink implements LogSink {
  private readonly queue: LogRecord[] = [];
  private drainPromise: Promise<void> | undefined;

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
      while (this.queue.length > 0) {
        const record = this.queue.shift();
        if (!record) continue;
        const line = `${JSON.stringify({ kind: 'log', ...record })}\n`;
        if (!process.stdout.write(line)) {
          await new Promise<void>((resolve) => {
            process.stdout.once('drain', resolve);
          });
        }
      }
    } finally {
      this.drainPromise = undefined;
      if (this.queue.length > 0) {
        void this.ensureDrain().catch(() => undefined);
      }
    }
  }
}
