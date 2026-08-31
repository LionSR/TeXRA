import { afterEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/runtime';
import { flowKey } from '@agent/node/persistedFlow';
import { readCliResumeDataForListing } from '@cli/runtime/toolUseResumeData';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/cli-resume-listing' });

const config = {
  agent: 'correct',
  agentCategory: 'workflow',
  model: 'deepseekT',
} as AgentConfig;

async function writeFlowRecord(
  executionId: ExecutionId,
  shared: Record<string, unknown>,
): Promise<void> {
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

describe('CLI listing resume data', () => {
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
  ])(
    'does not advertise a failed workflow with terminal %s as resumable',
    async (description, shared) => {
      const executionId =
        `workflow-terminal-${description.replaceAll(' ', '-')}` as ExecutionId;
      await writeFlowRecord(executionId, shared);

      await expect(
        readCliResumeDataForListing(executionId, config),
      ).resolves.toBeNull();
    },
  );
});
