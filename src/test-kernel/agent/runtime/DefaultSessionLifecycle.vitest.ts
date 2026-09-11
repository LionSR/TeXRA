// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

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
  it('warns once only when a non-default session is live at resolution', async () => {
    const {
      createTestSession,
      defaultSession,
      initializeDefaultSession,
      teardownDefaultSession,
    } = await importSessionRuntime();
    const processDefault = initializeDefaultSession({
      transcriptMode: { kind: 'ephemeral', reason: 'process default' },
    });

    try {
      expect(defaultSession()).toBe(processDefault);
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();

      const disposedSession = createTestSession({
        transcriptMode: { kind: 'ephemeral', reason: 'disposed non-default' },
      });
      disposedSession.dispose();
      expect(defaultSession()).toBe(processDefault);
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();

      const liveSession = createTestSession({
        transcriptMode: { kind: 'ephemeral', reason: 'live non-default' },
      });
      try {
        expect(defaultSession()).toBe(processDefault);
        expect(channelTraceMocks.warn).toHaveBeenCalledOnce();
        expect(channelTraceMocks.warn).toHaveBeenCalledWith(
          'defaultSession() resolved while a non-default SessionHandle was live. Pass or propagate the owning session instead.',
        );
      } finally {
        liveSession.dispose();
      }
    } finally {
      teardownDefaultSession();
    }
  });

  it('rejects access before explicit initialization', async () => {
    const { defaultSession, initializeDefaultSession, teardownDefaultSession } =
      await importSessionRuntime();

    expect(() => defaultSession()).toThrow(
      'The default session has not been initialized',
    );

    const transcriptMode = {
      kind: 'ephemeral',
      reason: 'default session lifecycle test',
    } as const;
    const session = initializeDefaultSession({ transcriptMode });
    try {
      expect(defaultSession()).toBe(session);
      expect(defaultSession().transcripts.mode).toEqual(transcriptMode);
      expect(() => initializeDefaultSession({ transcriptMode })).toThrow(
        'already been initialized',
      );
    } finally {
      teardownDefaultSession();
    }
  });

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

      const first = initializeDefaultSession({
        transcriptMode: { kind: 'ephemeral', reason: 'first activation' },
      });
      expect(() =>
        initializeDefaultSession({
          transcriptMode: { kind: 'ephemeral', reason: 'replacement attempt' },
        }),
      ).toThrow('already been initialized');

      const disposeSpy = vi.spyOn(first, 'dispose');

      teardownDefaultSession();

      expect(disposeSpy).toHaveBeenCalledOnce();
      expect(tryDefaultSession()).toBeUndefined();

      const second = initializeDefaultSession({
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
        teardownDefaultSession();
      }
    }),
  );
});
