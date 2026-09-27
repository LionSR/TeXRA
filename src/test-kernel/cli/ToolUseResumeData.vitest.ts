import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentConfig, SessionHandle } from '@agent/runtime';
import {
  cliRunStanding,
  type CliRunFacts,
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
  overrides: Partial<CliRunFacts> = {},
): CliRunFacts {
  return {
    id: runId,
    checkpointPresent: true,
    agentCategory: config.agentCategory,
    phase: RUN_OUTCOME.FAILED,
    ...overrides,
  };
}

let runCounter = 0;

/** Run ids are hex-branded; the case name lives in the test title. */
function mintRunId(): RunId {
  runCounter += 1;
  return `beef${runCounter.toString(16).padStart(2, '0')}` as RunId;
}

/**
 * A workflow run's snapshot. A terminal rejection is a halted snapshot with no
 * model failure whose loop halted FAILED; anything else stays continuable.
 */
function workflowSnapshot(terminal: boolean): FlowSnapshotPayload {
  return {
    family: 'toolUse',
    runtime: {
      phase: terminal ? 'halted' : 'model.ready',
      round: 0,
      turn: 1,
      modelId: config.model,
      modelCompatibilityKey: null,
      lastError: null,
      declinedRoutes: [],
    },
    state: { stateSlices: null, offeredTools: [], toolsetHash: '0'.repeat(64) },
  };
}

/** A run whose last round ended on a rejection with no round left to clear
 *  it. */
const TERMINAL_REJECTION = true;

describe('CLI listing resumability', () => {
  let session: SessionHandle;
  beforeEach(async () => {
    session = await Effect.runPromise(createProcessSession());
  });

  function resumableOf(facts: CliRunFacts): Promise<boolean> {
    return Effect.runPromise(
      cliRunStanding(facts, session).pipe(
        Effect.map((standing) => standing.resumable),
      ),
    );
  }

  /** Open the run aggregate the way a round does, halting it FAILED when
   *  `terminal`. */
  async function writeSnapshot(runId: RunId, terminal: boolean): Promise<void> {
    publishTestRunStart(session, runId);
    await Effect.runPromise(session.settlePublications());
    await Effect.runPromise(session.ledger.acquire(runId));
    await Effect.runPromise(
      session.ledger.appendBatch(runId, null, [
        {
          type: 'flow.snapshot',
          aggregateId: aggregateId('run', runId),
          payload: workflowSnapshot(terminal),
        },
        ...(terminal
          ? [
              {
                type: 'flow.step' as const,
                aggregateId: aggregateId('run', runId),
                payload: {
                  family: 'toolUse' as const,
                  step: 'halted' as const,
                  turn: 1,
                  outcome: RUN_OUTCOME.FAILED,
                },
              },
            ]
          : []),
      ]),
    );
  }

  it.each([['no snapshot', { checkpointPresent: false }]])(
    'does not advertise a row with %s, without reading its state',
    async (_description, overrides) => {
      const runId = mintRunId();
      // A continuable snapshot is on the aggregate, so reading it would answer
      // `true`. Only the free fact can produce the `false` asserted below.
      await writeSnapshot(runId, false);

      await expect(resumableOf(listingFacts(runId, overrides))).resolves.toBe(
        false,
      );
    },
  );

  it.each([
    [
      'a tool-use row',
      { agentCategory: 'toolUse' as AgentConfig['agentCategory'] },
    ],
    ['a workflow row that did not fail', { phase: RUN_OUTCOME.CANCELLED }],
  ])(
    'advertises %s without reading its snapshot',
    async (_description, overrides) => {
      const runId = mintRunId();
      // A terminal rejection is on the aggregate, so a read would answer
      // `false`. Only the short-circuit can produce the `true` asserted below.
      await writeSnapshot(runId, TERMINAL_REJECTION);

      await expect(resumableOf(listingFacts(runId, overrides))).resolves.toBe(
        true,
      );
    },
  );

  it('does not advertise a failed workflow with a terminal rejection', async () => {
    const runId = mintRunId();
    await writeSnapshot(runId, TERMINAL_REJECTION);

    await expect(resumableOf(listingFacts(runId))).resolves.toBe(false);
  });
});
