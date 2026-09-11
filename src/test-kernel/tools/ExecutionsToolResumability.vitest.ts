// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getRunStore } from '@agent/storage';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import type { RunId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';

const BASE_FLOW_RECORD: FlowRecord = {
  shared: { messages: [] },
  cursor: { nextNodeId: 'start' },
};

async function writeRecord(runId: RunId, record: unknown): Promise<void> {
  await getRunStore(runId).write(flowKey(runId), record);
}

describe('ExecutionsTool resumability fallback', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
  });

  it('does not label metadata-free resumable flow records as completed', async () => {
    const runId = 'abc123abc123' as RunId;
    await writeRecord(runId, BASE_FLOW_RECORD);

    const result = await new ExecutionsTool().call({
      path: `/executions/${runId}`,
    });

    expect(result.status).toBe('executed');
    expect(result.output).toContain('Status: resumable');
    expect(result.output).not.toContain('Status: completed');
  });

  it.each([
    { pathSuffix: '', runId: 'abc123abc124' },
    { pathSuffix: '/conversation', runId: 'abc123abc125' },
  ] as const)(
    'does not treat invalid metadata-free flow records as found (path suffix "$pathSuffix")',
    async ({ pathSuffix, runId: rawId }) => {
      const runId = rawId as RunId;
      await writeRecord(runId, { ...BASE_FLOW_RECORD, shared: null });

      const result = await new ExecutionsTool().call({
        path: `/executions/${runId}${pathSuffix}`,
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain(`Run not found: ${runId}`);
    },
  );
});
