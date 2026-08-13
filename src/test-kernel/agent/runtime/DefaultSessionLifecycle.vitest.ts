import { beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  vi.resetModules();
  channelTraceMocks.warn.mockReset();
});

/** Fresh module instances per test (beforeEach resets the module registry). */
async function importSessionRuntime() {
  const sessionModule = await import('@agent/runtime/SessionHandle');
  const { StreamLogStore } = await import('@transcript');
  return { ...sessionModule, StreamLogStore };
}

describe('default session lifecycle', () => {
  it('warns once only when a non-default session is live at resolution', async () => {
    const {
      SessionHandle,
      defaultSession,
      initializeDefaultSession,
      teardownDefaultSession,
      StreamLogStore,
    } = await importSessionRuntime();
    const processDefault = initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral('process default'),
    });

    try {
      expect(defaultSession()).toBe(processDefault);
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();

      const disposedSession = new SessionHandle({
        transcripts: StreamLogStore.ephemeral('disposed non-default'),
      });
      disposedSession.dispose();
      expect(defaultSession()).toBe(processDefault);
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();

      const liveSession = new SessionHandle({
        transcripts: StreamLogStore.ephemeral('live non-default'),
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

  it('does not let a throwing warning sink break or repeat fallback resolution', async () => {
    const warningFailure = new Error('warning sink failed');
    channelTraceMocks.warn.mockImplementation(() => {
      throw warningFailure;
    });
    const {
      SessionHandle,
      defaultSession,
      initializeDefaultSession,
      teardownDefaultSession,
      StreamLogStore,
    } = await importSessionRuntime();
    const processDefault = initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral('process default'),
    });
    const liveSession = new SessionHandle({
      transcripts: StreamLogStore.ephemeral('live non-default'),
    });

    try {
      expect(defaultSession()).toBe(processDefault);
      expect(channelTraceMocks.warn).toHaveBeenCalledOnce();
    } finally {
      liveSession.dispose();
      teardownDefaultSession();
    }
  });

  it('rejects access before explicit initialization', async () => {
    const {
      defaultSession,
      initializeDefaultSession,
      teardownDefaultSession,
      StreamLogStore,
    } = await importSessionRuntime();

    expect(() => defaultSession()).toThrow(
      'The default session has not been initialized',
    );

    const transcripts = StreamLogStore.ephemeral(
      'default session lifecycle test',
    );
    const session = initializeDefaultSession({ transcripts });
    try {
      expect(defaultSession()).toBe(session);
      expect(defaultSession().transcripts).toBe(transcripts);
      expect(() => initializeDefaultSession({ transcripts })).toThrow(
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

  it('resolves an explicitly threaded session without a process default', async () => {
    const { SessionHandle, currentSession, tryDefaultSession, StreamLogStore } =
      await importSessionRuntime();
    const { createRunContext, withRunContext } =
      await import('@agent/runtime/RunContext');
    const owned = new SessionHandle({
      transcripts: StreamLogStore.ephemeral('explicitly threaded session'),
    });

    try {
      const resolved = withRunContext(
        createRunContext({ session: owned }),
        () => currentSession(),
      );

      expect(resolved).toBe(owned);
      expect(tryDefaultSession()).toBeUndefined();
    } finally {
      owned.dispose();
    }
  });

  it('can initialize again only after explicit teardown', async () => {
    const {
      defaultSession,
      initializeDefaultSession,
      teardownDefaultSession,
      tryDefaultSession,
      StreamLogStore,
    } = await importSessionRuntime();

    const first = initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral('first activation'),
    });
    expect(() =>
      initializeDefaultSession({
        transcripts: StreamLogStore.ephemeral('replacement attempt'),
      }),
    ).toThrow('already been initialized');

    const originalDispose = first.dispose.bind(first);
    const disposeSpy = vi.spyOn(first, 'dispose').mockImplementation(() => {
      expect(tryDefaultSession()).toBeUndefined();
      originalDispose();
    });

    teardownDefaultSession();

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(tryDefaultSession()).toBeUndefined();

    const second = initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral('second activation'),
    });
    try {
      expect(defaultSession()).toBe(second);
      expect(second).not.toBe(first);
    } finally {
      teardownDefaultSession();
    }
  });
});
