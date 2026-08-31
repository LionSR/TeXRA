import { afterEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/runtime';
import { flowKey } from '@agent/node/persistedFlow';
import { readCliResumeDataForListing } from '@cli/runtime/toolUseResumeData';
import { KVStore } from '@common/storage/KVStore';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { reflectionFlowShared } from '@test/agent/progressTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from '@transcript/streamDataPaths';
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
  await StorageFS.delete(STREAM_DATA_DIR, { recursive: true }).catch(
    () => undefined,
  );
});

describe('CLI listing resume data', () => {
  it('advertises a historical row after healing its exact sidecar edge', async () => {
    const executionId = 'c86441' as ExecutionId;
    const streamId = 'historical-listing-stream' as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
    });
    await writeFlowRecord(
      executionId,
      reflectionFlowShared({ currentRound: 1 }),
    );
    await new KVStore(streamDataDir(streamId)).write(STREAM_DATA_KEYS.META, {
      executionId,
    });

    await expect(
      readCliResumeDataForListing(executionId, config),
    ).resolves.toMatchObject({
      type: 'workflow',
      executionId,
    });
    await expect(
      getExecutionStore(executionId).readMeta(),
    ).resolves.toMatchObject({ streamId });
  });

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
