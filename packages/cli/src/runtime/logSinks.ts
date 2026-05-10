// Local imports - logger
import type { LogRecord, LogSink } from '@logger/structuredLogger';

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
  private head = 0;
  private draining = false;
  private idle = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  write(record: LogRecord): void {
    this.queue.push(record);
    if (!this.draining) {
      this.draining = true;
      this.idle = new Promise<void>((resolve) => {
        this.resolveIdle = resolve;
      });
      setImmediate(() => this.drain());
    }
  }

  async flush(): Promise<void> {
    if (this.draining) await this.idle;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private drain(): void {
    while (this.head < this.queue.length) {
      const record = this.queue[this.head++];
      const line = `${JSON.stringify({ kind: 'log', ...record })}\n`;
      if (!process.stdout.write(line)) {
        process.stdout.once('drain', () => setImmediate(() => this.drain()));
        return;
      }
    }

    this.queue.length = 0;
    this.head = 0;
    this.draining = false;
    const resolve = this.resolveIdle;
    this.resolveIdle = null;
    resolve?.();
  }
}
