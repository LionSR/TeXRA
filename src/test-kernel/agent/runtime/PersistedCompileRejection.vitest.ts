import { afterEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getRunStore } from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import { hasTerminalPersistedCompileRejection } from '@agent/runtime/persistedCompileRejection';
import type { RunId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/persisted-compile-rejection' });

// Run ids are hex (`RunIdSchema`), and the lease claim directory re-parses
// them, so the fixture mints a real one rather than a descriptive label.
const runId = 'c0de1cea5e01' as RunId;

async function writeFlowRecord(shared: Record<string, unknown>): Promise<void> {
  await getRunStore(runId).write(flowKey(runId), {
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

    await expect(hasTerminalPersistedCompileRejection(runId)).resolves.toBe(
      true,
    );
  });
});
