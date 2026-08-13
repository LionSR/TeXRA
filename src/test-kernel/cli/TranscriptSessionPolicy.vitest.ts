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
      initializeHeadlessTranscriptSession: vi.fn(async () => {
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

  it('reclaims an orphaned stream sidecar when a headless session opens', async () => {
    vi.resetModules();
    const [
      { initPlatform },
      { createTempDirPlatform },
      { StreamLogStore, StreamSnapshotStore },
      { initializeDefaultSession, teardownDefaultSession },
      { GoalStore },
      { initializeHeadlessTranscriptSession },
    ] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/tempDirPlatform'),
      import('@transcript'),
      import('@agent/runtime/SessionHandle'),
      import('@tools/goal'),
      import('@cli/runtime/transcriptSession'),
    ]);
    initPlatform(
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
    const result = await initializeHeadlessTranscriptSession(
      async () => transcripts,
    );

    await expect(
      result.session.snapshots.listPersistedStreams(),
    ).resolves.toEqual([]);
    expect(GoalStore.getForStream(orphan)).toBeNull();
  });
});
