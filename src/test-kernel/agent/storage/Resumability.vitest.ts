import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  clearStoreCache,
  deriveResumability,
  EXECUTION_META_SCHEMA_VERSION,
  getExecutionStore,
  RESUMABILITY_CAUSE,
} from '@agent/storage';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';

const BASE_FLOW_RECORD: FlowRecord = {
  flowName: 'texra',
  params: {},
  shared: { messages: [] },
  createdAt: '2026-07-05T00:00:00.000Z',
  nodes: [],
};

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
    vi.restoreAllMocks();
  });

  async function writeFlow(executionId: ExecutionId): Promise<void> {
    await getExecutionStore(executionId).write(
      flowKey(executionId),
      BASE_FLOW_RECORD,
    );
  }

  async function writeTerminalStatus(
    executionId: ExecutionId,
    terminalStatus: string,
  ): Promise<void> {
    await getExecutionStore(executionId).writeMeta({
      schemaVersion: EXECUTION_META_SCHEMA_VERSION,
      timestamp: '2026-07-05T00:00:00.000Z',
      terminalStatus,
    });
  }

  it('does not let a stale flow record make completed executions resumable', async () => {
    const executionId = 'completed-with-flow' as ExecutionId;
    await writeTerminalStatus(executionId, EXECUTION_STATUS.COMPLETED);
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.TERMINAL_COMPLETED,
      terminalStatus: EXECUTION_STATUS.COMPLETED,
    });
  });

  it('does not let a stale flow record make failed executions resumable', async () => {
    const executionId = 'failed-with-flow' as ExecutionId;
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.TERMINAL_FAILED,
      terminalStatus: EXECUTION_STATUS.ERROR,
    });
  });

  it('marks interrupted executions with a valid flow record as resumable', async () => {
    const executionId = 'interrupted-with-flow' as ExecutionId;
    await writeTerminalStatus(executionId, EXECUTION_STATUS.INTERRUPTED);
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: true,
      cause: RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW,
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('marks missing-terminal executions with a valid flow record as resumable', async () => {
    const executionId = 'crash-with-flow' as ExecutionId;
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: true,
      cause: RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('reports missing flow records as not resumable', async () => {
    const executionId = 'missing-flow' as ExecutionId;

    await expect(deriveResumability(executionId)).resolves.toEqual({
      resumable: false,
      cause: RESUMABILITY_CAUSE.MISSING_FLOW,
    });
  });

  it('reports invalid flow records as not resumable', async () => {
    const executionId = 'invalid-flow' as ExecutionId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      ...BASE_FLOW_RECORD,
      shared: null,
    });

    await expect(deriveResumability(executionId)).resolves.toEqual({
      resumable: false,
      cause: RESUMABILITY_CAUSE.INVALID_FLOW,
    });
  });

  it('reports invalid metadata as not resumable even with a valid flow record', async () => {
    const executionId = 'invalid-meta-with-flow' as ExecutionId;
    const store = getExecutionStore(executionId);
    await store.write('meta', {
      schemaVersion: 999,
      timestamp: '2026-07-05T00:00:00.000Z',
    });
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.INVALID_META,
    });
  });

  it('reports unreadable flow records as not resumable', async () => {
    const executionId = 'unreadable-flow' as ExecutionId;
    const store = getExecutionStore(executionId);
    await writeFlow(executionId);
    const originalRead = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (key) => {
      if (key === flowKey(executionId)) {
        throw new Error('disk offline');
      }
      return originalRead(key);
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.UNREADABLE_FLOW,
    });
  });
});
