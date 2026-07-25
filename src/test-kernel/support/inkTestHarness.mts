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

/** Render against an explicit terminal size and return handles for assertions
 *  and cleanup. Use this for components that read `useWindowSize()`:
 *  `renderToString(..., { columns })` sizes Yoga but leaves that hook reading
 *  the ambient process stdout. */
export function renderWithTerminalSize(
  ink: any,
  node: any,
  columns: number,
  rows = 24,
): { readonly instance: any; readonly stdout: FakeStdout } {
  const stdout = new FakeStdout(columns, rows);
  const instance = ink.render(node, {
    stdin: new FakeStdin(false),
    stdout,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { instance, stdout };
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
