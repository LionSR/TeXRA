import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { clearStoreCache, getRunStore } from '@agent/storage';
import type { AgentConfig } from '@agent/runtime';
import { flowKey } from '@agent/node/persistedFlow';
import {
  isCliRunResumable as isCliRunResumableEffect,
  type CliRunResumabilityFacts,
} from '@cli/runtime/toolUseResumeData';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/cli-resume-listing' });

function isCliRunResumable(facts: CliRunResumabilityFacts): Promise<boolean> {
  return Effect.runPromise(
    isCliRunResumableEffect(facts, createProcessSession()),
  );
}

const config = {
  agent: 'correct',
  agentCategory: 'workflow',
  model: 'deepseekT',
} as AgentConfig;

/** A failed workflow row: the one shape whose checkpoint is still read. */
function listingFacts(
  runId: RunId,
  overrides: Partial<CliRunResumabilityFacts> = {},
): CliRunResumabilityFacts {
  return {
    id: runId,
    checkpointPresent: true,
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
  runId: RunId,
  shared: Record<string, unknown>,
): Promise<void> {
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

describe('CLI listing resumability', () => {
  it.each([['no checkpoint file', { checkpointPresent: false }]])(
    'does not advertise a row with %s, without reading its state',
    async (description, overrides) => {
      const runId = `gate-${description.replaceAll(' ', '-')}` as RunId;
      // A continuable record is on disk, so reading it would answer `true`.
      // Only the free fact can produce the `false` asserted below.
      await writeFlowRecord(runId, { currentRound: 0, totalRounds: 4 });

      await expect(
        isCliRunResumable(listingFacts(runId, overrides)),
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
      const runId = `free-${description.replaceAll(' ', '-')}` as RunId;
      // A terminal rejection is on disk, so a parse would answer `false`.
      // Only the short-circuit can produce the `true` asserted below.
      await writeFlowRecord(runId, TERMINAL_REJECTION);

      await expect(
        isCliRunResumable(listingFacts(runId, overrides)),
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
      const runId =
        `workflow-terminal-${description.replaceAll(' ', '-')}` as RunId;
      await writeFlowRecord(runId, shared);

      await expect(isCliRunResumable(listingFacts(runId))).resolves.toBe(false);
    },
  );
});
