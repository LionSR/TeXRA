// Test setup imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { DeleteExecutionOptions } from '@agent/storage';
import { SessionStores } from '@controllers/progressView/backend/state/SessionStores';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { releaseStreamResources } from '@tools/approval';
import { StreamSnapshotStore } from '@transcript';

describe('SessionStores deletion coordination', () => {
  it('releases one canonical stream once when single and bulk deletion overlap', async () => {
    const session = createTestSession();
    const stream = 'tool@test#abc001' as StreamTabId;
    session.transcripts.ensureStream(stream);
    session.followUps.acquire(stream);
    let unblockDeletion!: () => void;
    const deletionBlocked = new Promise<void>((resolve) => {
      unblockDeletion = resolve;
    });
    const deleteExecution = vi.fn(
      async (executionId: ExecutionId, options?: DeleteExecutionOptions) => {
        await deletionBlocked;
        await options?.beforeDelete?.();
        return { status: 'deleted' as const, executionId };
      },
    );
    const releases: StreamTabId[] = [];
    session.followUps.onRelease((released) => releases.push(released));
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots: new StreamSnapshotStore(),
      deleteExecution,
      onCanonicalStreamDeleted: (deleted) =>
        releaseStreamResources(deleted, session),
    });

    try {
      const single = stores.deleteStream(stream);
      await vi.waitFor(() => expect(deleteExecution).toHaveBeenCalledOnce());
      const bulk = stores.deleteAll();
      unblockDeletion();

      await expect(Promise.all([single, bulk])).resolves.toEqual([
        'deleted',
        { active: new Set(), failed: new Set() },
      ]);
      expect(releases).toEqual([stream]);
    } finally {
      session.dispose();
    }
  });

  it('releases deleted streams and excludes retained active streams', async () => {
    const session = createTestSession();
    const deleted = 'canonical-delete' as StreamTabId;
    const retained = 'tool@test#ac71e1' as StreamTabId;
    session.transcripts.ensureStream(deleted);
    session.transcripts.ensureStream(retained);
    const releases: StreamTabId[] = [];
    session.followUps.onRelease((stream) => releases.push(stream));
    const stores = new SessionStores({
      streamLogs: session.transcripts,
      snapshots: new StreamSnapshotStore(),
      deleteExecution: async (executionId) => ({
        status: 'active',
        executionId,
        heartbeatAt: Date.now(),
      }),
      onCanonicalStreamDeleted: (stream) =>
        releaseStreamResources(stream, session),
    });

    try {
      const result = await stores.deleteAll();

      expect(result.active).toEqual(new Set([retained]));
      expect(result.failed).toEqual(new Set());
      expect(releases).toEqual([deleted]);
    } finally {
      session.dispose();
    }
  });
});
