import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@agent/runtime/runAgent');
  vi.doUnmock('@cli/runtime/runtimeHost');
  vi.doUnmock('@cli/runtime/transcriptSession');
  vi.resetModules();
});

describe('CLI transcript session policy', () => {
  it('fails a headless execution before runtime construction when opening fails', async () => {
    vi.resetModules();
    const failure = new Error('transcript directory is unreadable');
    const runAgent = vi.fn();
    const createCliRuntimeHost = vi.fn();
    vi.doMock('@cli/runtime/transcriptSession', () => ({
      initializeHeadlessTranscriptSession: vi.fn(async () => {
        throw failure;
      }),
    }));
    vi.doMock('@agent/runtime/runAgent', () => ({ runAgent }));
    vi.doMock('@cli/runtime/runtimeHost', () => ({ createCliRuntimeHost }));
    const { executeCliRequest } = await import('@cli/runtime/runExecution');

    await expect(
      executeCliRequest(
        { config: {}, executionId: 'exec-open-failure' } as never,
        {
          cwd: '/workspace',
          mode: 'headless',
          outputFormat: 'text',
          approvalPolicy: 'never',
        } as never,
      ),
    ).rejects.toBe(failure);

    expect(createCliRuntimeHost).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('selects ephemeral mode only through the explicit interactive policy', async () => {
    vi.resetModules();
    const { initializeInteractiveTranscriptSession } =
      await import('@cli/runtime/transcriptSession');
    const warning = vi.fn();

    const result = await initializeInteractiveTranscriptSession(
      {
        onPersistentOpenFailure: 'use-ephemeral',
        showPersistentWarning: warning,
      },
      async () => {
        throw new Error('permission denied');
      },
    );

    try {
      expect(result.canResume).toBe(false);
      expect(result.session.transcripts.mode).toEqual({
        kind: 'ephemeral',
        reason: 'Persistent transcript opening failed: permission denied',
      });
      expect(warning).toHaveBeenCalledOnce();
      expect(result.warning).toContain('cannot be resumed');
    } finally {
      result.session.dispose();
    }
  });

  it('does not fall back when the interactive policy requires persistence', async () => {
    vi.resetModules();
    const { initializeInteractiveTranscriptSession } =
      await import('@cli/runtime/transcriptSession');
    const failure = new Error('permission denied');

    await expect(
      initializeInteractiveTranscriptSession(
        { onPersistentOpenFailure: 'fail' },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });
});
