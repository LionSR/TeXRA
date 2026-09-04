import { afterEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/runtime';
import { flowKey } from '@agent/node/persistedFlow';
import {
  isCliRunResumable,
  type CliRunResumabilityFacts,
} from '@cli/runtime/toolUseResumeData';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/cli-resume-listing' });

const config = {
  agent: 'correct',
  agentCategory: 'workflow',
  model: 'deepseekT',
} as AgentConfig;

/** A failed workflow row: the one shape whose checkpoint is still read. */
function listingFacts(
  executionId: ExecutionId,
  overrides: Partial<CliRunResumabilityFacts> = {},
): CliRunResumabilityFacts {
  return {
    id: executionId,
    checkpointPresent: true,
    streamId: `${config.agent}@run#${executionId}` as StreamTabId,
    agentCategory: config.agentCategory,
    outcome: RUN_OUTCOME.FAILED,
    ...overrides,
  };
}

const TERMINAL_REJECTION = {
  currentRound: 1,
  totalRounds: 2,
  unresolvedCompileRejection: true,
};

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
      // A continuable record is on disk, so reading it would answer `true`.
      // Only the two free facts can produce the `false` asserted below.
      await writeFlowRecord(executionId, { currentRound: 0, totalRounds: 4 });

      await expect(
        isCliRunResumable(listingFacts(executionId, overrides)),
      ).resolves.toBe(false);
    },
  );

  it.each([
    [
      'a tool-use row',
      { agentCategory: 'toolUse' as AgentConfig['agentCategory'] },
    ],
    ['a workflow row that did not fail', { outcome: RUN_OUTCOME.CANCELLED }],
  ])(
    'advertises %s without parsing its checkpoint',
    async (description, overrides) => {
      const executionId =
        `free-${description.replaceAll(' ', '-')}` as ExecutionId;
      // A terminal rejection is on disk, so a parse would answer `false`.
      // Only the short-circuit can produce the `true` asserted below.
      await writeFlowRecord(executionId, TERMINAL_REJECTION);

      await expect(
        isCliRunResumable(listingFacts(executionId, overrides)),
      ).resolves.toBe(true);
    },
  );

  it.each([
    ['the unresolved rejection marker', TERMINAL_REJECTION],
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

      await expect(isCliRunResumable(listingFacts(executionId))).resolves.toBe(
        false,
      );
    },
  );
});
