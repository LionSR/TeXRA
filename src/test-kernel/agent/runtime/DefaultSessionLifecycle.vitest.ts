import { describe, expect, it, vi } from 'vitest';

describe('default session lifecycle', () => {
  it('rejects access before explicit initialization', async () => {
    vi.resetModules();
    const { defaultSession, initializeDefaultSession, teardownDefaultSession } =
      await import('@agent/runtime/SessionHandle');
    const { StreamLogStore } = await import('@transcript');

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

  it('defers extension host session access until composition is initialized', async () => {
    vi.resetModules();
    const { initializeDefaultSession, teardownDefaultSession } =
      await import('@agent/runtime/SessionHandle');
    const { StreamLogStore } = await import('@transcript/StreamLogStore');
    const { extensionAgentRuntimeHost } =
      await import('@frontend/agentRuntime/extensionAgentRuntimeHost');

    expect(() => extensionAgentRuntimeHost.interactions).toThrow(
      'The default session has not been initialized',
    );

    const session = initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral(
        'extension composition lifecycle test',
      ),
    });
    try {
      expect(extensionAgentRuntimeHost.interactions).toBe(session.interactions);
    } finally {
      teardownDefaultSession();
    }
  });

  it('can initialize again only after explicit teardown', async () => {
    vi.resetModules();
    const {
      defaultSession,
      initializeDefaultSession,
      teardownDefaultSession,
      tryDefaultSession,
    } = await import('@agent/runtime/SessionHandle');
    const { StreamLogStore } = await import('@transcript/StreamLogStore');

    const first = initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral('first activation'),
    });
    expect(() =>
      initializeDefaultSession({
        transcripts: StreamLogStore.ephemeral('replacement attempt'),
      }),
    ).toThrow('already been initialized');

    const originalDispose = first.dispose.bind(first);
    const disposeSpy = vi
      .spyOn(first, 'dispose')
      .mockImplementation((options) => {
        expect(tryDefaultSession()).toBeUndefined();
        originalDispose(options);
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
