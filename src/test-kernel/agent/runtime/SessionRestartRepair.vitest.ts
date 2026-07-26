import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import { EXECUTION_LEASE_STALE_MS } from '@agent/storage/executionLease';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  EXECUTION_STATUS,
  LOG_LEVELS,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StreamLogStore } from '@transcript';
import { StorageFS } from '@utils/files';

setupPlatform({ workspacePath: '/workspace/session-restart-repair' });

const executionId = 'abc123' as ExecutionId;
const streamId = `crashed#${executionId}` as StreamTabId;

afterEach(async () => {
  await StorageFS.delete('executionLeases', { recursive: true }).catch(
    () => undefined,
  );
  await StorageFS.delete('executions', { recursive: true }).catch(
    () => undefined,
  );
  await StorageFS.delete('streamLogs', { recursive: true }).catch(
    () => undefined,
  );
  await StorageFS.delete('streamLogSummaries', { recursive: true }).catch(
    () => undefined,
  );
  clearStoreCache();
});

describe('SessionHandle restart repair', () => {
  it('repairs a crashed run before a host is attached', async () => {
    const transcripts = await StreamLogStore.open();
    transcripts.append(streamId, {
      id: 'crashed-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    await transcripts.flush();

    const executionStore = getExecutionStore(executionId);
    await executionStore.writeMeta({
      timestamp: '2026-07-26T00:00:00.000Z',
    });
    await executionStore.write(flowKey(executionId), { invalid: true });

    const heartbeatAt = Date.now() - EXECUTION_LEASE_STALE_MS - 1;
    await StorageFS.ensureDir('executionLeases');
    await StorageFS.writeAtomic(
      `executionLeases/${executionId}.json`,
      JSON.stringify({
        version: 1,
        executionId,
        ownerToken: '00000000-0000-4000-8000-000000000001',
        acquiredAt: heartbeatAt,
        heartbeatAt,
      }),
    );

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await session.waitUntilReady();

      expect(session.status.get(streamId)).toBe(STREAM_PHASE.FAILED);
      await expect(executionStore.readMeta()).resolves.toMatchObject({
        terminalStatus: EXECUTION_STATUS.ERROR,
      });
      await expect(
        executionStore.read(flowKey(executionId)),
      ).resolves.toBeUndefined();
      expect(transcripts.get(streamId)?.getRange(0).at(-1)).toMatchObject({
        type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
        data: { status: 'failed' },
      });
    } finally {
      session.dispose();
    }
  });

  it('surfaces a repair write failure at the readiness boundary', async () => {
    const transcripts = await StreamLogStore.open();
    transcripts.append(streamId, {
      id: 'failing-running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1_000,
      data: { status: STREAM_PHASE.RUNNING },
    });
    const repairError = new Error('restart repair write failed');
    vi.spyOn(transcripts, 'endRunningGroupsForStreams').mockRejectedValue(
      repairError,
    );

    const session = new SessionHandle({
      transcripts,
      restartRepair: 'deferred',
    });
    try {
      await expect(session.waitUntilReady()).rejects.toBe(repairError);
    } finally {
      session.dispose();
    }
  });
});
