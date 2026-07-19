// Standard library imports
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

/** Load Ink and React from the CLI workspace that owns those dependencies. */
export async function loadInk(): Promise<{
  readonly ink: any;
  readonly React: any;
  readonly requireFromInk: ReturnType<typeof createRequire>;
}> {
  return {
    ink: (await import(cliRequire.resolve('ink'))) as any,
    React: ((await import(cliRequire.resolve('react'))) as any).default,
    requireFromInk: createRequire(cliRequire.resolve('ink')),
  };
}

/** Minimal writable TTY used by interactive Ink tests. */
export class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  output = '';

  constructor(
    public columns = 80,
    public rows = 24,
  ) {
    super();
  }

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }

  getColorDepth(): number {
    return 24;
  }
}

/** Minimal readable TTY used by interactive Ink tests. */
export class FakeStdin extends EventEmitter {
  private readonly chunks: string[] = [];

  constructor(readonly isTTY = true) {
    super();
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
    this.emit('readable');
  }

  read(): string | null {
    return this.chunks.shift() ?? null;
  }

  ref(): void {}
  unref(): void {}
  pause(): void {}
  resume(): void {}
  setEncoding(): void {}
  setRawMode(): void {}
}
