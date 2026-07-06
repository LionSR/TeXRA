import { describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { getExecutionStore } from '@agent/storage';
import { BaseNode } from '@agent/node';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  PersistedFlow,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import type { ExecutionId } from '@shared/schemas';

setupPlatform({ workspacePath: '/workspace' });

class CompleteNode extends BaseNode<{ count: number }> {
  async post(shared: { count: number }): Promise<string> {
    shared.count += 1;
    return 'complete';
  }
}

class ContinueOnceNode extends BaseNode<{ count: number; continue: boolean }> {
  async post(shared: { count: number; continue: boolean }): Promise<string> {
    shared.count += 1;
    return shared.continue ? 'again' : 'complete';
  }
}

describe('PersistedFlow', () => {
  it('writes the current schema version into new flow records', async () => {
    const executionId = 'abc126' as ExecutionId;
    const store = getExecutionStore(executionId);
    const flow = new PersistedFlow(new CompleteNode(), store, executionId);

    await flow.run({ count: 0 });

    await expect(
      store.read<FlowRecord>(flowKey(executionId)),
    ).resolves.toMatchObject({
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      cursor: { nextNodeId: null, lastAction: 'complete' },
      nodes: [{ action: 'complete' }],
    });
  });

  it('replays from the cursor rather than the audit node log', async () => {
    const executionId = 'abc127' as ExecutionId;
    const store = getExecutionStore(executionId);
    const first = new ContinueOnceNode();
    const second = new CompleteNode();
    first.on('again', second);
    const flow = new PersistedFlow(first, store, executionId);

    await store.write(flowKey(executionId), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      flowName: 'texra',
      params: {},
      shared: { count: 0, continue: false },
      createdAt: new Date().toISOString(),
      cursor: { nextNodeId: 'start/again', lastAction: 'again' },
      nodes: [],
    } satisfies FlowRecord);

    await flow.run({ count: 999, continue: true });

    await expect(
      store.read<FlowRecord>(flowKey(executionId)),
    ).resolves.toMatchObject({
      shared: { count: 1, continue: false },
      cursor: { nextNodeId: null, lastAction: 'complete' },
      nodes: [{ action: 'complete', nodeId: 'start/again' }],
    });
  });

  it('migrates legacy node-path records to cursor replay on the next step', async () => {
    const executionId = 'abc128' as ExecutionId;
    const store = getExecutionStore(executionId);
    const first = new ContinueOnceNode();
    const second = new CompleteNode();
    first.on('again', second);
    const flow = new PersistedFlow(first, store, executionId);

    await store.write(flowKey(executionId), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      flowName: 'texra',
      params: {},
      shared: { count: 1, continue: false },
      createdAt: new Date().toISOString(),
      nodes: [{ action: 'again' }],
    } satisfies FlowRecord);

    await flow.run({ count: 999, continue: true });

    await expect(
      store.read<FlowRecord>(flowKey(executionId)),
    ).resolves.toMatchObject({
      shared: { count: 2, continue: false },
      cursor: { nextNodeId: null, lastAction: 'complete' },
      nodes: [
        { action: 'again' },
        { action: 'complete', nodeId: 'start/again' },
      ],
    });
  });
});
