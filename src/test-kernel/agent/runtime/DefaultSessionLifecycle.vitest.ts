// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { assert, beforeEach, describe, expect, vi } from 'vitest';

import type { WorkspaceRoots } from '@platform/workspaceRoots';

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@agent/trace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/trace')>();
  return {
    ...actual,
    createChannelTrace: vi.fn(() => ({
      ...actual.noopTrace,
      warn: channelTraceMocks.warn,
    })),
  };
});

// SessionHandle now binds `createLog('sessionHandle')` at import time, so
// the warn spy intercepts that factory for the `sessionHandle` channel
// only; the graph's other `createLog` consumers keep the real factory, and
// the `@agent/trace` mock above still covers the remaining
// `createChannelTrace` singletons (e.g. `runRegistry`).
vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return {
    ...actual,
    createLog: vi.fn((channel: string) =>
      channel === 'sessionHandle'
        ? {
            debug: vi.fn(),
            info: vi.fn(),
            warn: channelTraceMocks.warn,
            error: vi.fn(),
          }
        : actual.createLog(channel),
    ),
  };
});

beforeEach(() => {
  vi.resetModules();
  channelTraceMocks.warn.mockReset();
});

/** Fresh module instances per test (beforeEach resets the module registry). */
async function importSessionRuntime() {
  // The reset also emptied the fresh roots module a session reads at
  // construction; reinstall the suite default into it.
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform();
  await import('@test/support/sessionGraphTestSetup');
  const sessionModule = await import('@agent/runtime/SessionHandle');
  // A session beside the process default: its own storage root, as a
  // desktop paper's, since one root holds one session.
  const { createTestSession } = await import('@test/support/sessionTestUtils');
  return { ...sessionModule, createTestSession };
}

describe('default session lifecycle', () => {
  // Opens real sessions on the process session owner and keeps the real
  // clock it runs on today. The finalizers are registered teardown first and
  // the live session second, so their LIFO order reproduces the nesting the
  // two `finally` blocks used to give: dispose runs, then teardown.
  it.live(
    'warns once only when a non-default session is live at resolution',
    () =>
      Effect.gen(function* () {
        const {
          createTestSession,
          defaultSession,
          initializeDefaultSession,
          teardownDefaultSession,
        } = yield* Effect.promise(() => importSessionRuntime());
        const processDefault = yield* initializeDefaultSession({
          transcriptMode: { kind: 'ephemeral', reason: 'process default' },
        });
        yield* Effect.addFinalizer(() => teardownDefaultSession());

        expect(defaultSession()).toBe(processDefault);
        expect(channelTraceMocks.warn).not.toHaveBeenCalled();

        const disposedSession = createTestSession({
          transcriptMode: { kind: 'ephemeral', reason: 'disposed non-default' },
        });
        yield* disposedSession.dispose();
        expect(defaultSession()).toBe(processDefault);
        expect(channelTraceMocks.warn).not.toHaveBeenCalled();

        const liveSession = createTestSession({
          transcriptMode: { kind: 'ephemeral', reason: 'live non-default' },
        });
        yield* Effect.addFinalizer(() => liveSession.dispose());

        expect(defaultSession()).toBe(processDefault);
        expect(channelTraceMocks.warn).toHaveBeenCalledOnce();
        expect(channelTraceMocks.warn).toHaveBeenCalledWith(
          'defaultSession() resolved while a non-default SessionHandle was live. Pass or propagate the owning session instead.',
        );
      }),
  );

  // Opens and releases a real session on the process session owner, and keeps
  // the real clock it runs on today.
  it.live('rejects access before explicit initialization', () =>
    Effect.gen(function* () {
      const {
        defaultSession,
        initializeDefaultSession,
        teardownDefaultSession,
      } = yield* Effect.promise(() => importSessionRuntime());

      expect(() => defaultSession()).toThrow(
        'The default session has not been initialized',
      );

      const transcriptMode = {
        kind: 'ephemeral',
        reason: 'default session lifecycle test',
      } as const;
      const session = yield* initializeDefaultSession({ transcriptMode });
      yield* Effect.gen(function* () {
        expect(defaultSession()).toBe(session);
        expect(defaultSession().transcripts.mode).toEqual(transcriptMode);
        // `initializeDefaultSession` carries no error channel and a second
        // initialization dies (SessionHandle.ts:1403-1415), so the assertion
        // reads the exit and its die reason rather than `Effect.flip`.
        const exit = yield* Effect.exit(
          initializeDefaultSession({ transcriptMode }),
        );
        assert(Exit.isFailure(exit));
        const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
        expect(defect).toBeInstanceOf(Error);
        expect((defect as Error).message).toContain('already been initialized');
      }).pipe(Effect.ensuring(teardownDefaultSession()));
    }),
  );

  it('throws from the sanctioned fallback in a no-default process', async () => {
    // Explicit-session migration ratchet (#7694). currentSession() is the
    // `?? defaultSession()` fallback every other run-scoped site resolves
    // through, and the desktop host deliberately installs no process default,
    // so the fallback must stay loud there. Silencing it — by installing a
    // default for the desktop or by inventing an implicit memory-only session
    // — would make the remaining migration sites work by accident.
    const { currentSession, tryDefaultSession } =
      await import('@agent/runtime/SessionHandle');

    expect(tryDefaultSession()).toBeUndefined();
    expect(() => currentSession()).toThrow(
      'The default session has not been initialized',
    );
    expect(tryDefaultSession()).toBeUndefined();
  });

  it.live.each([
    { label: 'implicit process roots', rootKind: 'implicit' },
    { label: 'inherited explicit roots', rootKind: 'inherited' },
  ] as const)(
    'retains its opening $label until the owner closes it after a host swap',
    ({ rootKind }) =>
      Effect.gen(function* () {
        const { initializeDefaultSession } = yield* Effect.promise(() =>
          importSessionRuntime(),
        );
        const { installPlatform } = yield* Effect.promise(
          () => import('@test/support/setupPlatform'),
        );
        const { closeSession, listSessions } = yield* Effect.promise(
          () => import('@agent/runtime/sessionGraph'),
        );
        const originalStorage = '/workspace/first/.texra/storage';

        yield* Effect.promise(() =>
          installPlatform({ storagePath: originalStorage }),
        );
        const processRoots = yield* Effect.promise(async () => {
          const { processWorkspaceRoots } =
            await import('@platform/workspaceRoots');
          return processWorkspaceRoots();
        });
        const originalRoots = {
          workspace: processRoots.workspace,
          storage: processRoots.storage,
          globalStorage: processRoots.globalStorage,
          config: processRoots.config,
          workspaceState: processRoots.workspaceState,
          globalState: processRoots.globalState,
        } satisfies WorkspaceRoots;
        const roots =
          rootKind === 'inherited'
            ? (Object.create(processRoots) as WorkspaceRoots)
            : undefined;
        if (roots) {
          expect(Object.keys(roots)).toEqual([]);
        }
        const session = yield* initializeDefaultSession({
          transcriptMode: { kind: 'ephemeral', reason: 'root snapshot test' },
          ...(roots && { roots }),
        });
        try {
          yield* Effect.promise(() =>
            installPlatform({
              storagePath: '/workspace/second/.texra/storage',
            }),
          );

          expect(session.roots).toEqual(originalRoots);
          expect(yield* listSessions()).toEqual([session]);
          expect(yield* closeSession(originalStorage)).toEqual({
            settled: true,
            abandoned: [],
          });
          expect(yield* listSessions()).toEqual([]);
        } finally {
          yield* closeSession(originalStorage);
        }
      }),
  );

  // `closeSession` forks a real-time `Effect.sleep` deadline budget and
  // races it against settlement promises, so this test needs the live clock.
  it.live('can initialize again only after explicit teardown', () =>
    Effect.gen(function* () {
      const {
        defaultSession,
        initializeDefaultSession,
        teardownDefaultSession,
        tryDefaultSession,
      } = yield* Effect.promise(() => importSessionRuntime());

      const first = yield* initializeDefaultSession({
        transcriptMode: { kind: 'ephemeral', reason: 'first activation' },
      });
      // `initializeDefaultSession` carries no error channel and a second
      // initialization dies (SessionHandle.ts:1403-1415), so the assertion
      // reads the exit and its die reason rather than `Effect.flip`.
      const exit = yield* Effect.exit(
        initializeDefaultSession({
          transcriptMode: {
            kind: 'ephemeral',
            reason: 'replacement attempt',
          },
        }),
      );
      assert(Exit.isFailure(exit));
      const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
      expect(defect).toBeInstanceOf(Error);
      expect((defect as Error).message).toContain('already been initialized');

      const disposeSpy = vi.spyOn(first, 'dispose');

      yield* teardownDefaultSession();

      expect(disposeSpy).toHaveBeenCalledOnce();
      expect(tryDefaultSession()).toBeUndefined();

      const second = yield* initializeDefaultSession({
        transcriptMode: { kind: 'ephemeral', reason: 'second activation' },
      });
      try {
        expect(defaultSession()).toBe(second);
        expect(second).not.toBe(first);
        // The default session is read from its owner: closing its root
        // through the owner leaves no default session behind.
        const { closeSession } = yield* Effect.promise(
          () => import('@agent/runtime/sessionGraph'),
        );
        const { processWorkspaceRoots } = yield* Effect.promise(
          () => import('@platform/workspaceRoots'),
        );
        yield* closeSession(processWorkspaceRoots().storage);
        expect(tryDefaultSession()).toBeUndefined();
      } finally {
        yield* teardownDefaultSession();
      }
    }),
  );
});
