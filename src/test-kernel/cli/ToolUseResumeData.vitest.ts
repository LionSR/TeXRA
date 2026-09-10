import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import { clearStoreCache, getRunStore } from '@agent/storage';
import type { AgentConfig } from '@agent/runtime';
import { flowKey } from '@agent/node/persistedFlow';
import {
  isCliRunResumable as isCliRunResumableEffect,
  type CliRunResumabilityFacts,
} from '@cli/runtime/toolUseResumeData';
import { RUN_OUTCOME, type RunId, type StreamTabId } from '@shared/schemas';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/cli-resume-listing' });

function isCliRunResumable(
  facts: CliRunResumabilityFacts,
): Effect.Effect<boolean> {
  return isCliRunResumableEffect(facts, createProcessSession());
}

const config = {
  agent: 'correct',
  agentCategory: 'workflow',
  model: 'deepseekT',
} as AgentConfig;

/** A failed workflow row: the one shape whose checkpoint is still read. */
function listingFacts(
  executionId: RunId,
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
  executionId: RunId,
  shared: Record<string, unknown>,
): Promise<void> {
  await getRunStore(executionId).write(flowKey(executionId), {
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
  it.effect.each([
    ['no checkpoint file', { checkpointPresent: false }],
    ['no stamped stream id', { streamId: undefined }],
  ] as const)(
    'does not advertise a row with %s, without reading its state',
    ([description, overrides]) =>
      Effect.gen(function* () {
        const executionId = `gate-${description.replaceAll(' ', '-')}` as RunId;
        // A continuable record is on disk, so reading it would answer `true`.
        // Only the two free facts can produce the `false` asserted below.
        yield* Effect.promise(() =>
          writeFlowRecord(executionId, { currentRound: 0, totalRounds: 4 }),
        );

        expect(
          yield* isCliRunResumable(listingFacts(executionId, overrides)),
        ).toBe(false);
      }),
  );

  it.effect.each([
    [
      'a tool-use row',
      { agentCategory: 'toolUse' as AgentConfig['agentCategory'] },
    ],
    ['a workflow row that did not fail', { outcome: RUN_OUTCOME.CANCELLED }],
  ] as const)(
    'advertises %s without parsing its checkpoint',
    ([description, overrides]) =>
      Effect.gen(function* () {
        const executionId = `free-${description.replaceAll(' ', '-')}` as RunId;
        // A terminal rejection is on disk, so a parse would answer `false`.
        // Only the short-circuit can produce the `true` asserted below.
        yield* Effect.promise(() =>
          writeFlowRecord(executionId, TERMINAL_REJECTION),
        );

        expect(
          yield* isCliRunResumable(listingFacts(executionId, overrides)),
        ).toBe(true);
      }),
  );

  it.effect.each([
    ['the unresolved rejection marker', TERMINAL_REJECTION],
    [
      'legacy compile failure context',
      {
        currentRound: 1,
        totalRounds: 2,
        compileFailureContext: 'The generated document did not compile.',
      },
    ],
  ] as const)(
    'does not advertise a failed workflow with terminal %s as resumable',
    ([description, shared]) =>
      Effect.gen(function* () {
        const executionId =
          `workflow-terminal-${description.replaceAll(' ', '-')}` as RunId;
        yield* Effect.promise(() => writeFlowRecord(executionId, shared));

        expect(yield* isCliRunResumable(listingFacts(executionId))).toBe(false);
      }),
  );
});
