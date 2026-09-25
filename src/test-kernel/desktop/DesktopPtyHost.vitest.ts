// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, FileSystem } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import {
  createDesktopPtyHost,
  type DesktopPtyHostOptions,
} from '@desktop/main/desktopPtyHost';
import { createDeferred } from '@test/support/asyncTestUtils';

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

const TERMINAL_ID = 'workbench:terminal:1';

function createHost(
  overrides: Partial<DesktopPtyHostOptions> = {},
): ReturnType<typeof createDesktopPtyHost> {
  return createDesktopPtyHost({
    onData: vi.fn(),
    onExit: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  });
}

// The host reads the filesystem only to repair node-pty's own spawn helper,
// which a stubbed module load never reaches.
const noFileSystem = Effect.provide(FileSystem.layerNoop({}));

describe('desktop pty host', () => {
  it.effect(
    'ignores callbacks from a disposed session after its id is reused',
    () =>
      Effect.gen(function* () {
        const oldPty = createFakePty(101);
        const replacementPty = createFakePty(102);
        const spawnPty = vi
          .fn<SpawnPty>()
          .mockReturnValueOnce(oldPty)
          .mockReturnValueOnce(replacementPty);
        const onData = vi.fn();
        const onExit = vi.fn();
        const host = createHost({
          onData,
          onExit,
          loadPty: loadFakePty(spawnPty),
        });

        const oldSession = yield* host.create({
          id: TERMINAL_ID,
          cols: 80,
          rows: 24,
        });
        if (!oldSession) throw new Error('Expected the old session to start.');
        oldSession.dispose();
        const replacementSession = yield* host.create({
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
      }).pipe(noFileSystem),
  );

  it.effect(
    'abandons a session creation invalidated while its module loads',
    () =>
      Effect.gen(function* () {
        const pty = createFakePty(201);
        const spawnPty = vi.fn<SpawnPty>(() => pty);
        const firstLoad = createDeferred<PtyModule>();
        const loadPty = vi
          .fn<LoadPty>()
          .mockReturnValueOnce(firstLoad.promise)
          .mockResolvedValue({ spawn: spawnPty });
        const host = createHost({ loadPty });

        const staleCreation = yield* Effect.forkChild(
          host.create({ id: TERMINAL_ID, cols: 80, rows: 24 }),
        );
        // Let the creation start and reach its module load before disposal.
        yield* Effect.yieldNow;
        host.disposeAll();
        firstLoad.resolve({ spawn: spawnPty });

        expect(yield* Fiber.join(staleCreation)).toBeUndefined();
        expect(spawnPty).not.toHaveBeenCalled();
        expect(host.get(TERMINAL_ID)).toBeUndefined();

        const replacement = yield* host.create({
          id: TERMINAL_ID,
          cols: 100,
          rows: 30,
        });
        expect(replacement).toBeDefined();
        expect(spawnPty).toHaveBeenCalledOnce();
        expect(host.get(TERMINAL_ID)).toBe(replacement);
      }).pipe(noFileSystem),
  );

  it.effect('ignores a module-load failure from an invalidated creation', () =>
    Effect.gen(function* () {
      const loadFailure = createDeferred<PtyModule>();
      const host = createHost({
        loadPty: vi.fn<LoadPty>().mockReturnValue(loadFailure.promise),
      });

      const staleCreation = yield* Effect.forkChild(
        host.create({ id: TERMINAL_ID, cols: 80, rows: 24 }),
      );
      // Let the creation start and reach its module load before disposal.
      yield* Effect.yieldNow;
      host.disposeAll();
      loadFailure.reject(new Error('node-pty unavailable'));

      expect(yield* Fiber.join(staleCreation)).toBeUndefined();
      expect(host.get(TERMINAL_ID)).toBeUndefined();
    }).pipe(noFileSystem),
  );
});
