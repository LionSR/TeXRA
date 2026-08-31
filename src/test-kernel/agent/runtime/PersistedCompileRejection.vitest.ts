import { afterEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import { hasTerminalPersistedCompileRejection } from '@agent/runtime/persistedCompileRejection';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/persisted-compile-rejection' });

const executionId = 'terminal-compile-rejection' as ExecutionId;

async function writeFlowRecord(shared: Record<string, unknown>): Promise<void> {
  await getExecutionStore(executionId).write(flowKey(executionId), {
    shared,
    cursor: { nextNodeId: 'start' },
  });
}

afterEach(async () => {
  clearStoreCache();
  await StorageFS.delete('executions', { recursive: true }).catch(
    () => undefined,
  );
});

describe('persisted compile rejection lookup', () => {
  it.each([
    [
      'the unresolved rejection marker',
      {
        currentRound: 1,
        totalRounds: 2,
        unresolvedCompileRejection: true,
      },
    ],
    [
      'legacy compile failure context',
      {
        currentRound: 1,
        totalRounds: 2,
        compileFailureContext: 'The generated document did not compile.',
      },
    ],
  ])('recognizes terminal state from %s', async (_description, shared) => {
    await writeFlowRecord(shared);

    await expect(
      hasTerminalPersistedCompileRejection(executionId),
    ).resolves.toBe(true);
  });
});
