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
      nodes: [{ action: 'complete' }],
    });
  });
});
