import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
  const [{ teardownDefaultSession }, { cleanupTempDirs }] = await Promise.all([
    import('@agent/runtime/SessionHandle'),
    import('@test/support/tempDirPlatform'),
  ]);
  teardownDefaultSession();
  await cleanupTempDirs(tempDirs);
  vi.doUnmock('@agent/runtime/runAgent');
  vi.doUnmock('@cli/runtime/cliPresentationHost');
  vi.doUnmock('@cli/runtime/transcriptSession');
  vi.resetModules();
});

describe('CLI transcript session policy', () => {
  it('fails a headless execution before runtime construction when opening fails', async () => {
    vi.resetModules();
    await import('@test/support/sessionGraphTestSetup');
    const failure = new Error('transcript directory is unreadable');
    const runAgent = vi.fn();
    const createCliRuntimeHost = vi.fn();
    vi.doMock('@cli/runtime/transcriptSession', () => ({
      initializeCliTranscriptSession: vi.fn(async () => {
        throw failure;
      }),
    }));
    vi.doMock('@agent/runtime/runAgent', () => ({ runAgent }));
    vi.doMock('@cli/runtime/cliPresentationHost', () => ({
      createCliRuntimeHost,
    }));
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
});
