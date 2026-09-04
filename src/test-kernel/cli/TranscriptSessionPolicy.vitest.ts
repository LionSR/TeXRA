import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StreamTabId } from '@shared/schemas';
import { snapshotFacts } from '@test/support/storeTestDrivers';

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

  it('selects ephemeral mode only through the explicit interactive policy', async () => {
    vi.resetModules();
    const { installPlatform } = await import('@test/support/setupPlatform');
    await installPlatform();
    const { initializeCliTranscriptSession } =
      await import('@cli/runtime/transcriptSession');
    const warning = vi.fn();

    const result = await initializeCliTranscriptSession(
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
    const { initializeCliTranscriptSession } =
      await import('@cli/runtime/transcriptSession');
    const failure = new Error('permission denied');

    await expect(
      initializeCliTranscriptSession(
        { onPersistentOpenFailure: 'fail' },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });

  it('reclaims an orphaned stream sidecar after a headless session opens', async () => {
    vi.resetModules();
    const [
      { installFakeHost },
      { createTempDirPlatform },
      { StreamLogStore, StreamSnapshotStore },
      { initializeDefaultSession, teardownDefaultSession },
      { GoalStore },
      { initializeCliTranscriptSession },
    ] = await Promise.all([
      import('@test/support/setupPlatform'),
      import('@test/support/tempDirPlatform'),
      import('@transcript'),
      import('@agent/runtime/SessionHandle'),
      import('@tools/goal'),
      import('@cli/runtime/transcriptSession'),
    ]);
    await installFakeHost(
      await createTempDirPlatform('texra-cli-orphan-sweep-', tempDirs),
    );
    const orphan = 'orphaned-cli-stream' as StreamTabId;
    const writer = new StreamSnapshotStore();
    // Materialize a persisted sidecar via a durable current field;
    // descriptions are memory-only for current records (#9590 Stage 6).
    snapshotFacts(writer).setParentStream(
      orphan,
      'orphan-parent' as StreamTabId,
    );
    await writer.flush();
    await expect(writer.listPersistedStreams()).resolves.toEqual([orphan]);

    initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral('orphaned goal fixture'),
    });
    await GoalStore.start(orphan, 'orphaned goal');
    expect(GoalStore.getForStream(orphan)).not.toBeNull();
    teardownDefaultSession();

    const transcripts = await StreamLogStore.open();
    const result = await initializeCliTranscriptSession(
      { onPersistentOpenFailure: 'fail' },
      async () => transcripts,
    );

    // The sweep is scheduled off the ready path now, so the reclaim lands a
    // beat after the session opens instead of before it returns.
    // The goal is cleared after the sidecar directory goes, so both facts
    // are awaited together rather than asserting the second one early.
    await vi.waitFor(
      async () => {
        await expect(
          result.session.snapshots.listPersistedStreams(),
        ).resolves.toEqual([]);
        expect(GoalStore.getForStream(orphan)).toBeNull();
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});
