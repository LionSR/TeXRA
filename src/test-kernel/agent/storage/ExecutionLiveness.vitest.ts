import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  HEARTBEAT_INTERVAL_MS,
  clearStoreCache,
  getExecutionLiveness,
  getExecutionStore,
  listLiveExecutionIds,
  setHeartbeatOwnerHost,
  touchExecutionHeartbeat,
} from '@agent/storage';
import type { ExecutionId } from '@shared/schemas';

describe('execution liveness heartbeat (#8625)', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setHeartbeatOwnerHost('unknown');
  });

  async function writeRunningExecution(id: ExecutionId): Promise<void> {
    await getExecutionStore(id).writeMeta({
      timestamp: '2026-07-16T12:00:00.000Z',
    });
  }

  it('classifies a freshly heartbeaten, non-terminal execution as live, marked with its owner', async () => {
    const id = 'ab1001' as ExecutionId;
    setHeartbeatOwnerHost('cli');
    await writeRunningExecution(id);
    await touchExecutionHeartbeat(id);

    await expect(getExecutionLiveness(id)).resolves.toEqual({
      live: true,
      ownerHost: 'cli',
      ownerPid: process.pid,
    });
  });

  it('treats a stale heartbeat as not live (crashed run stays deletable)', async () => {
    const id = 'ab1002' as ExecutionId;
    await writeRunningExecution(id);
    await touchExecutionHeartbeat(id);

    vi.spyOn(Date, 'now').mockReturnValue(
      Date.now() + 6 * HEARTBEAT_INTERVAL_MS,
    );

    await expect(getExecutionLiveness(id).then((l) => l.live)).resolves.toBe(
      false,
    );
  });

  it('is not live without a heartbeat file (pre-heartbeat executions)', async () => {
    const id = 'ab1003' as ExecutionId;
    await writeRunningExecution(id);

    await expect(getExecutionLiveness(id).then((l) => l.live)).resolves.toBe(
      false,
    );
  });

  it('is not live once a terminal status is persisted, even with a fresh heartbeat', async () => {
    const id = 'ab1004' as ExecutionId;
    await getExecutionStore(id).writeMeta({
      timestamp: '2026-07-16T12:00:00.000Z',
      terminalStatus: 'completed',
    });
    await touchExecutionHeartbeat(id);

    await expect(getExecutionLiveness(id).then((l) => l.live)).resolves.toBe(
      false,
    );
  });

  it('is not live for an unknown execution id', async () => {
    await expect(
      getExecutionLiveness('ab1005' as ExecutionId).then((l) => l.live),
    ).resolves.toBe(false);
  });

  it('lists only the live executions', async () => {
    const live = 'ab2001' as ExecutionId;
    const finished = 'ab2002' as ExecutionId;
    const crashed = 'ab2003' as ExecutionId;
    await writeRunningExecution(live);
    await touchExecutionHeartbeat(live);
    await getExecutionStore(finished).writeMeta({
      timestamp: '2026-07-16T12:01:00.000Z',
      terminalStatus: 'completed',
    });
    await writeRunningExecution(crashed);

    await expect(listLiveExecutionIds()).resolves.toEqual([live]);
  });
});
