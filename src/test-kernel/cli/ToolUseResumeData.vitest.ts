import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { AgentConfig, SessionHandle } from '@agent/runtime';
import {
  isCliRunResumable as isCliRunResumableEffect,
  type CliRunResumabilityFacts,
} from '@cli/runtime/toolUseResumeData';
import {
  aggregateId,
  RUN_OUTCOME,
  type FlowSnapshotPayload,
  type RunId,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace/cli-resume-listing' });

const config = {
  agent: 'correct',
  agentCategory: 'workflow',
  model: 'deepseekT',
} as AgentConfig;

/** A failed workflow row: the one shape whose snapshot is still read. */
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

let runCounter = 0;

/** Run ids are hex-branded; the case name lives in the test title. */
function mintRunId(): RunId {
  runCounter += 1;
  return `beef${runCounter.toString(16).padStart(2, '0')}` as RunId;
}

type ReflectionState = Extract<
  FlowSnapshotPayload,
  { family: 'reflection' }
>['state'];

/** The reflection snapshot a round writes, minus the fields a case sets. */
function reflectionSnapshot(
  state: Partial<ReflectionState>,
): FlowSnapshotPayload {
  return {
    family: 'reflection',
    runtime: {
      phase: 'initial',
      round: 0,
      turn: 0,
      continuationIndex: 0,
      modelId: config.model,
      modelCompatibilityKey: null,
      lastError: null,
      pendingRetry: null,
    },
    references: { pendingIntents: [], pendingResponse: null },
    state: {
      currentRound: 0,
      totalRounds: 4,
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
      outputLocation: null,
      runStateSnapshot: { totalRounds: 4, totalResponseTimeMs: 0 },
      roundOutputs: [],
      continueRounds: true,
      endTurn: false,
      ...state,
    },
  };
}

/** A round that ended on a rejection with no round left to clear it. */
const TERMINAL_REJECTION: Partial<ReflectionState> = {
  currentRound: 1,
  totalRounds: 2,
  unresolvedCompileRejection: true,
};

describe('CLI listing resumability', () => {
  let session: SessionHandle;
  beforeEach(() => {
    session = createProcessSession();
  });

  function isCliRunResumable(facts: CliRunResumabilityFacts): Promise<boolean> {
    return Effect.runPromise(isCliRunResumableEffect(facts, session));
  }

  /** Open the run aggregate the way a reflection round does. */
  async function writeSnapshot(
    runId: RunId,
    state: Partial<ReflectionState>,
  ): Promise<void> {
    publishTestRunStart(session, runId);
    await session.settlePublications();
    await Effect.runPromise(session.ledger.acquire(runId));
    await Effect.runPromise(
      session.ledger.appendBatch(runId, null, [
        {
          type: 'flow.snapshot',
          aggregateId: aggregateId('run', runId),
          payload: reflectionSnapshot(state),
        },
      ]),
    );
  }

  it.each([['no snapshot', { checkpointPresent: false }]])(
    'does not advertise a row with %s, without reading its state',
    async (_description, overrides) => {
      const runId = mintRunId();
      // A continuable snapshot is on the aggregate, so reading it would answer
      // `true`. Only the free fact can produce the `false` asserted below.
      await writeSnapshot(runId, { currentRound: 0, totalRounds: 4 });

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
    'advertises %s without reading its snapshot',
    async (_description, overrides) => {
      const runId = mintRunId();
      // A terminal rejection is on the aggregate, so a read would answer
      // `false`. Only the short-circuit can produce the `true` asserted below.
      await writeSnapshot(runId, TERMINAL_REJECTION);

      await expect(
        isCliRunResumable(listingFacts(runId, overrides)),
      ).resolves.toBe(true);
    },
  );

  it('does not advertise a failed workflow with a terminal rejection', async () => {
    const runId = mintRunId();
    await writeSnapshot(runId, TERMINAL_REJECTION);

    await expect(isCliRunResumable(listingFacts(runId))).resolves.toBe(false);
  });
});
