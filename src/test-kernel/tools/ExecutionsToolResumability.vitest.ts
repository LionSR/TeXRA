// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';

const BASE_FLOW_RECORD: FlowRecord = {
  flowName: 'texra',
  params: {},
  shared: { messages: [] },
  createdAt: '2026-07-05T00:00:00.000Z',
  nodes: [],
};

async function writeRecord(
  executionId: ExecutionId,
  record: unknown,
): Promise<void> {
  await getExecutionStore(executionId).write(flowKey(executionId), record);
}

describe('ExecutionsTool resumability fallback', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
  });

  it('does not label metadata-free resumable flow records as completed', async () => {
    const executionId = 'abc123abc123' as ExecutionId;
    await writeRecord(executionId, BASE_FLOW_RECORD);

    const result = await new ExecutionsTool().call({
      path: `/executions/${executionId}`,
    });

    expect(result.status).toBe('executed');
    expect(result.output).toContain('Status: resumable');
    expect(result.output).not.toContain('Status: completed');
  });

  it.each([
    { pathSuffix: '', executionId: 'abc123abc124' },
    { pathSuffix: '/conversation', executionId: 'abc123abc125' },
  ] as const)(
    'does not treat invalid metadata-free flow records as found (path suffix "$pathSuffix")',
    async ({ pathSuffix, executionId: rawId }) => {
      const executionId = rawId as ExecutionId;
      await writeRecord(executionId, { ...BASE_FLOW_RECORD, shared: null });

      const result = await new ExecutionsTool().call({
        path: `/executions/${executionId}${pathSuffix}`,
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain(`Execution not found: ${executionId}`);
    },
  );
});
