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
  /** Append-only transcript. It does not model terminal erase/cursor controls. */
  output = '';
  readonly writes: string[] = [];

  constructor(
    public columns = 80,
    public rows = 24,
  ) {
    super();
  }

  write(chunk: string): boolean {
    this.output += chunk;
    this.writes.push(chunk);
    return true;
  }

  getColorDepth(): number {
    return 24;
  }
}

/** Ink's render instance, narrowed to what the test kernel drives. `ink` is a
 *  `packages/cli` dependency that repo-root type resolution does not see, so
 *  the module handle itself stays untyped. `repaint` comes from the workspace
 *  Ink patch (`patches/ink@7.1.1.patch`), not upstream Ink. */
interface InkInstance {
  unmount(): void;
  rerender(node: any): void;
  repaint(options?: {
    readonly clearScrollback?: boolean;
    readonly emitLayout?: boolean;
    readonly preserveStatic?: boolean;
  }): void;
  waitUntilExit(): Promise<void>;
}

export interface InkRenderHandles {
  readonly instance: InkInstance;
  readonly stdin: FakeStdin;
  readonly stdout: FakeStdout;
}

/** Mount an Ink tree on fake TTYs the test can drive, and return the handles
 *  for assertions and cleanup. The only `ink.render` call site in the test
 *  kernel: the option bag (raw mode, Ctrl-C handling, console patching) is what
 *  the per-suite copies used to drift on. Pass `stdin`/`stdout` when the test
 *  instruments the runs before the mount. */
export function renderInteractive(
  ink: any,
  node: any,
  options: {
    readonly columns?: number;
    readonly rows?: number;
    readonly debug?: boolean;
    readonly stdin?: FakeStdin;
    readonly stdout?: FakeStdout;
  } = {},
): InkRenderHandles {
  const stdin = options.stdin ?? new FakeStdin();
  const stdout =
    options.stdout ?? new FakeStdout(options.columns, options.rows);
  const instance = ink.render(node, {
    stdin,
    stdout,
    debug: options.debug ?? false,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  }) as InkInstance;
  return { instance, stdin, stdout };
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
  options: { readonly debug?: boolean } = {},
): InkRenderHandles {
  return renderInteractive(ink, node, {
    debug: options.debug ?? false,
    // Debug renders may still mount useInput; let its raw-mode setup succeed.
    stdin: new FakeStdin(options.debug ?? false),
    stdout: new FakeStdout(columns, rows),
  });
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
  // Unlike real tty.ReadStream, these return void rather than `this` — a
  // chained call (e.g. `stdin.setRawMode(true).resume()`) will throw here.
  pause(): void {}
  resume(): void {}
  setEncoding(): void {}
  setRawMode(): void {}
}
