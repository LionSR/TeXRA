import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  clearStoreCache,
  deriveResumability,
  EXECUTION_META_SCHEMA_VERSION,
  finalizeExecution,
  getExecutionStore,
  RESUMABILITY_CAUSE,
} from '@agent/storage';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';

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
    await writeMeta(executionId, { terminalStatus });
  }

  async function writeMeta(
    executionId: ExecutionId,
    {
      terminalStatus,
      outcome,
    }: { terminalStatus?: string; outcome?: RunOutcome },
  ): Promise<void> {
    await getExecutionStore(executionId).writeMeta({
      schemaVersion: EXECUTION_META_SCHEMA_VERSION,
      timestamp: '2026-07-05T00:00:00.000Z',
      terminalStatus,
      outcome,
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

  it('stays non-resumable when terminal metadata persists but flow deletion fails', async () => {
    const executionId = 'failed-finalization-with-flow' as ExecutionId;
    await writeMeta(executionId, {});
    await writeFlow(executionId);
    const store = getExecutionStore(executionId);
    vi.spyOn(store, 'delete').mockRejectedValueOnce(
      new Error('flow delete failed'),
    );

    await expect(
      finalizeExecution({
        executionId,
        terminalStatus: EXECUTION_STATUS.ERROR,
        flowRecord: 'delete',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      stage: 'flow-record-delete',
      terminalStatusPersisted: true,
    });

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

  it('marks cancelled executions with a valid flow record as resumable', async () => {
    const executionId = 'cancelled-with-flow' as ExecutionId;
    await writeMeta(executionId, {
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await writeFlow(executionId);

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: true,
      cause: RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW,
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: BASE_FLOW_RECORD,
    });
  });

  it('does not mark cancelled executions resumable without a flow record', async () => {
    const executionId = 'cancelled-missing-flow' as ExecutionId;
    await writeMeta(executionId, {
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
    });

    await expect(deriveResumability(executionId)).resolves.toMatchObject({
      resumable: false,
      cause: RESUMABILITY_CAUSE.MISSING_FLOW,
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
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

  it('accepts an unstamped legacy envelope and preserves extra fields', async () => {
    const executionId = 'legacy-extra-flow-envelope' as ExecutionId;
    const legacyRecord = {
      ...BASE_FLOW_RECORD,
      legacyOwner: { host: 'extension' },
    };
    await getExecutionStore(executionId).write(
      flowKey(executionId),
      legacyRecord,
    );

    const decision = await deriveResumability(executionId);

    expect(decision).toMatchObject({
      resumable: true,
      cause: RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
    });
    if (!decision.resumable) return;
    expect(decision.flowRecord).toEqual(legacyRecord);
    expect(Object.hasOwn(decision.flowRecord, 'schemaVersion')).toBe(false);
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

  it('does not conflate a stored null flow envelope with an absent key', async () => {
    const executionId = 'null-flow-envelope' as ExecutionId;
    await getExecutionStore(executionId).write(flowKey(executionId), null);

    await expect(deriveResumability(executionId)).resolves.toEqual({
      resumable: false,
      cause: RESUMABILITY_CAUSE.INVALID_FLOW,
    });
  });

  it('rejects flow records from a future envelope schema version', async () => {
    const executionId = 'future-flow-envelope' as ExecutionId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      ...BASE_FLOW_RECORD,
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION + 1,
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

  it('projects only resumable executions into WAITING streams', async () => {
    const crashExecutionId = 'waiting-crash-with-flow' as ExecutionId;
    const cancelledExecutionId = 'waiting-cancelled-with-flow' as ExecutionId;
    const completedExecutionId = 'waiting-completed-with-flow' as ExecutionId;
    const missingFlowExecutionId =
      'waiting-interrupted-missing-flow' as ExecutionId;

    await writeFlow(crashExecutionId);
    await writeMeta(cancelledExecutionId, {
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await writeFlow(cancelledExecutionId);
    await writeTerminalStatus(completedExecutionId, EXECUTION_STATUS.COMPLETED);
    await writeFlow(completedExecutionId);
    await writeTerminalStatus(
      missingFlowExecutionId,
      EXECUTION_STATUS.INTERRUPTED,
    );

    const streamIdsByExecutionId = new Map<StreamTabId, ExecutionId>([
      ['crash-stream' as StreamTabId, crashExecutionId],
      ['cancelled-stream' as StreamTabId, cancelledExecutionId],
      ['completed-stream' as StreamTabId, completedExecutionId],
      ['missing-flow-stream' as StreamTabId, missingFlowExecutionId],
    ]);

    await expect(detectWaitingStreams(streamIdsByExecutionId)).resolves.toEqual(
      new Set<StreamTabId>([
        'crash-stream' as StreamTabId,
        'cancelled-stream' as StreamTabId,
      ]),
    );
  });
});
