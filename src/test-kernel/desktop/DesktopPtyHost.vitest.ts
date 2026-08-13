// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  createDesktopPtyHost,
  type DesktopPtyHostOptions,
} from '@desktop/main/desktopPtyHost';

type LoadPty = NonNullable<DesktopPtyHostOptions['loadPty']>;
type PtyModule = Awaited<ReturnType<LoadPty>>;
type SpawnPty = PtyModule['spawn'];
type PtyProcess = ReturnType<SpawnPty>;

interface FakePty {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

function createFakePty(pid: number): FakePty & PtyProcess {
  let dataListener = (_data: string): void => {};
  let exitListener: Parameters<PtyProcess['onExit']>[0] = () => {};
  return {
    pid,
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    kill: vi.fn<(signal?: string) => void>(),
    onData(listener) {
      dataListener = listener;
    },
    onExit(listener) {
      exitListener = listener;
    },
    emitData: (data) => dataListener(data),
    emitExit: (exitCode) => exitListener({ exitCode }),
  };
}

function loadFakePty(spawn: SpawnPty): LoadPty {
  return async () => ({ spawn });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve = (_value: T): void => {};
  let reject = (_error: unknown): void => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const TERMINAL_ID = 'workbench:terminal:1';

function createHost(
  overrides: Partial<DesktopPtyHostOptions> = {},
): ReturnType<typeof createDesktopPtyHost> {
  return createDesktopPtyHost({
    onData: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  });
}

describe('desktop pty host', () => {
  it('ignores callbacks from a disposed session after its id is reused', async () => {
    const oldPty = createFakePty(101);
    const replacementPty = createFakePty(102);
    const spawnPty = vi
      .fn<SpawnPty>()
      .mockReturnValueOnce(oldPty)
      .mockReturnValueOnce(replacementPty);
    const onData = vi.fn();
    const onExit = vi.fn();
    const host = createHost({ onData, onExit, loadPty: loadFakePty(spawnPty) });

    const oldSession = await host.create({
      id: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    if (!oldSession) throw new Error('Expected the old session to start.');
    oldSession.dispose();
    const replacementSession = await host.create({
      id: TERMINAL_ID,
      cols: 100,
      rows: 30,
    });
    if (!replacementSession) {
      throw new Error('Expected the replacement session to start.');
    }

    expect(replacementSession).not.toBe(oldSession);
    expect(spawnPty).toHaveBeenCalledTimes(2);
    oldPty.emitData('late output');
    oldPty.emitExit(0);

    expect(host.get(TERMINAL_ID)).toBe(replacementSession);
    expect(onData).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    replacementPty.emitData('new output');
    replacementPty.emitExit(7);

    expect(onData).toHaveBeenCalledWith(TERMINAL_ID, 'new output');
    expect(onExit).toHaveBeenCalledWith(TERMINAL_ID, 7);
    expect(host.get(TERMINAL_ID)).toBeUndefined();
  });

  it('abandons a session creation invalidated while its module loads', async () => {
    const pty = createFakePty(201);
    const spawnPty = vi.fn<SpawnPty>(() => pty);
    const firstLoad = deferred<PtyModule>();
    const loadPty = vi
      .fn<LoadPty>()
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValue({ spawn: spawnPty });
    const host = createHost({ loadPty });

    const staleCreation = host.create({
      id: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    host.disposeAll();
    firstLoad.resolve({ spawn: spawnPty });

    expect(await staleCreation).toBeUndefined();
    expect(spawnPty).not.toHaveBeenCalled();
    expect(host.get(TERMINAL_ID)).toBeUndefined();

    const replacement = await host.create({
      id: TERMINAL_ID,
      cols: 100,
      rows: 30,
    });
    expect(replacement).toBeDefined();
    expect(spawnPty).toHaveBeenCalledOnce();
    expect(host.get(TERMINAL_ID)).toBe(replacement);
  });

  it('ignores a module-load failure from an invalidated creation', async () => {
    const loadFailure = deferred<PtyModule>();
    const host = createHost({
      loadPty: vi.fn<LoadPty>().mockReturnValue(loadFailure.promise),
    });

    const staleCreation = host.create({
      id: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    host.disposeAll();
    loadFailure.reject(new Error('node-pty unavailable'));

    await expect(staleCreation).resolves.toBeUndefined();
    expect(host.get(TERMINAL_ID)).toBeUndefined();
  });
});
