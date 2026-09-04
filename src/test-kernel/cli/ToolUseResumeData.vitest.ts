import { afterEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import type { AgentExecutionListingEntry } from '@agent/storage';
import type { AgentConfig } from '@agent/runtime';
import { flowKey } from '@agent/node/persistedFlow';
import { isCliListingResumable } from '@cli/runtime/toolUseResumeData';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/cli-resume-listing' });

const config = {
  agent: 'correct',
  agentCategory: 'workflow',
  model: 'deepseekT',
} as AgentConfig;

function listingEntry(
  executionId: ExecutionId,
  overrides: Partial<AgentExecutionListingEntry> = {},
): AgentExecutionListingEntry {
  return {
    kind: 'run',
    identity: { kind: 'agent', agent: config.agent },
    id: executionId,
    timestamp: '2026-05-18T08:00:00.000Z',
    record: config,
    checkpointPresent: true,
    streamId: `${config.agent}@run#${executionId}` as StreamTabId,
    ...overrides,
  };
}

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

describe('CLI listing resumability', () => {
  it.each([
    ['no checkpoint file', { checkpointPresent: false }],
    ['no stamped stream id', { streamId: undefined }],
  ])(
    'does not advertise a row with %s, without reading its state',
    async (description, overrides) => {
      const executionId =
        `gate-${description.replaceAll(' ', '-')}` as ExecutionId;
      // A terminal rejection is on disk, so a `true` answer could only come
      // from reading it — the two free facts must decide first.
      await writeFlowRecord(executionId, {
        currentRound: 1,
        totalRounds: 2,
        unresolvedCompileRejection: true,
      });

      await expect(
        isCliListingResumable(listingEntry(executionId, overrides)),
      ).resolves.toBe(false);
    },
  );

  it('advertises a checkpointed, stamped row without parsing its checkpoint', async () => {
    const executionId = 'toolUse-checkpointed' as ExecutionId;

    await expect(
      isCliListingResumable(
        listingEntry(executionId, {
          record: { ...config, agentCategory: 'toolUse' } as AgentConfig,
        }),
      ),
    ).resolves.toBe(true);
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
        isCliListingResumable(listingEntry(executionId)),
      ).resolves.toBe(false);
    },
  );
});
