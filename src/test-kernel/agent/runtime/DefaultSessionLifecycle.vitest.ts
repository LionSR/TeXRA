import { describe, expect, it, vi } from 'vitest';

describe('default session lifecycle', () => {
  it('rejects access before explicit initialization', async () => {
    vi.resetModules();
    const { defaultSession, initializeDefaultSession } =
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
      session.dispose();
    }
  });

  it('defers extension host session access until composition is initialized', async () => {
    vi.resetModules();
    const { initializeDefaultSession } =
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
      session.dispose();
    }
  });
});
