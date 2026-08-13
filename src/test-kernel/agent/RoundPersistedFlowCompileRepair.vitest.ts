// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { TraceEmitter } from '@agent/trace';
import { BaseNode } from '@agent/node';
import {
  RoundPersistedFlow,
  type RoundAwareState,
} from '@agent/implementations/flows/reflection/RoundPersistedFlow';
import {
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { createFakeKv } from '@test/support/FakeExecutionKVStore';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { isObject } from '@utils/core';

/**
 * Regression coverage for #7077: a compile failure on what would have been
 * the final round must get exactly one extra ("repair") round carrying the
 * failure context — gated on the reject-on-compile-failure setting, and
 * never granted twice even if the repair round itself fails again.
 *
 * These tests exercise `RoundPersistedFlow`'s round-continuation decision
 * directly (the single source of truth the fix touches), using a minimal
 * fake node and an in-memory KV store instead of standing up the full
 * reflection flow (model handler, prompt builder, LaTeX compile, etc).
 */

interface FakeShared extends RoundAwareState {
  /** Round indices actually executed, in order. */
  roundsRun: number[];
  /** compileFailureContext observed by each executed round, if any. */
  contextSeenByRound: Record<number, string | undefined>;
  /** Round indices that should simulate a compile failure. */
  failingRounds: number[];
  /** Mirrors OutputNode's one-shot repair context (set on failure, consumed next round). */
  compileFailureContext?: string;
  /** Mirrors the persisted "already granted a repair round" flag. */
  compileRepairRoundGranted?: boolean;
  /** Mirrors the rejectOnCompileFailure setting. */
  rejectOnCompileFailureEnabled: boolean;
}

/**
 * A single node standing in for the whole reflection round (PrepareContext +
 * ... + OutputNode): it records the round it ran in, captures whatever
 * compileFailureContext it saw (mimicking PrepareContextNode consuming it),
 * then mimics OutputNode by setting a fresh compileFailureContext if this
 * round is scripted to fail compilation.
 */
class FakeRoundNode extends BaseNode<FakeShared> {
  async post(shared: FakeShared): Promise<undefined> {
    shared.roundsRun.push(shared.currentRound);
    shared.contextSeenByRound[shared.currentRound] =
      shared.compileFailureContext;
    delete shared.compileFailureContext;

    if (shared.failingRounds.includes(shared.currentRound)) {
      shared.compileFailureContext = `compile failed on round ${shared.currentRound}`;
    }
    return undefined;
  }
}

function makeFlow() {
  const node = new FakeRoundNode();
  return new RoundPersistedFlow<FakeShared>(node, createFakeKv(), {
    callbacks: {
      grantExtraRound: (s) => {
        if (
          !s.compileFailureContext ||
          s.compileRepairRoundGranted ||
          !s.rejectOnCompileFailureEnabled
        ) {
          return false;
        }
        s.compileRepairRoundGranted = true;
        return true;
      },
    },
  });
}

function makeFlowWithKv(kv: ReturnType<typeof createFakeKv>) {
  return new RoundPersistedFlow<FakeShared>(new FakeRoundNode(), kv);
}

function initialShared(overrides: Partial<FakeShared>): FakeShared {
  return {
    currentRound: 0,
    totalRounds: 2,
    continueRounds: true,
    roundsRun: [],
    contextSeenByRound: {},
    failingRounds: [],
    rejectOnCompileFailureEnabled: true,
    ...overrides,
  };
}

async function runFlow(overrides: Partial<FakeShared>): Promise<FakeShared> {
  const flow = makeFlow();
  await flow.run(initialShared(overrides));
  return (await flow.getShared())!;
}

describe('RoundPersistedFlow bounded compile-repair round (#7077)', () => {
  it('grants exactly one extra round when the final configured round fails to compile', async () => {
    // totalRounds: 2 (rounds 0 and 1 configured); round 1 (the last one) fails.
    const shared = await runFlow({ failingRounds: [1] });

    // Round 0, round 1 (configured, fails), and a granted repair round 2.
    expect(shared.roundsRun).toEqual([0, 1, 2]);
    // The repair round (2) received the failure context from round 1.
    expect(shared.contextSeenByRound[2]).toBe('compile failed on round 1');
    expect(shared.compileRepairRoundGranted).toBe(true);
  });

  it('does not grant an extra round when a clean final round has no failure context', async () => {
    const shared = await runFlow({ failingRounds: [] });

    expect(shared.roundsRun).toEqual([0, 1]);
    expect(shared.compileRepairRoundGranted).toBeUndefined();
  });

  it('does not grant an extra round when rejectOnCompileFailure is off', async () => {
    const shared = await runFlow({
      failingRounds: [1],
      rejectOnCompileFailureEnabled: false,
    });

    expect(shared.roundsRun).toEqual([0, 1]);
    expect(shared.compileRepairRoundGranted).toBeUndefined();
  });

  it('does not chain a second repair round when the repair round itself fails again', async () => {
    // Both the configured final round (1) and the granted repair round (2) fail.
    const shared = await runFlow({ failingRounds: [1, 2] });

    // Exactly one repair round (2) — no round 3, even though round 2 also failed.
    expect(shared.roundsRun).toEqual([0, 1, 2]);
    expect(shared.compileRepairRoundGranted).toBe(true);
  });
});

describe('RoundPersistedFlow cancelled-round recovery (#10098)', () => {
  it('restarts the terminal current-round cursor without advancing the round', async () => {
    const kv = createFakeKv();
    const initialFlow = makeFlowWithKv(kv);
    const shared = initialShared({ totalRounds: 1 });
    await initialFlow.run(shared);
    const cancelledShared = (await initialFlow.getShared())!;
    cancelledShared.continueRounds = false;
    await initialFlow.setShared(cancelledShared);

    const resumedFlow = makeFlowWithKv(kv);
    await resumedFlow.restartCurrentRound(cancelledShared);
    await expect(resumedFlow.run(cancelledShared)).resolves.toBe(
      RUN_OUTCOME.COMPLETED,
    );

    expect((await resumedFlow.getShared())?.roundsRun).toEqual([0, 0]);
  });
});

type OutcomeShared = RoundAwareState;

interface OutcomeControl {
  readonly terminalOutcome: RunOutcome | 'throws';
  readonly abortController: AbortController;
}

class OutcomeRoundNode extends BaseNode<OutcomeShared> {
  constructor(private readonly control: OutcomeControl) {
    super();
  }

  async post(shared: OutcomeShared): Promise<undefined> {
    if (shared.currentRound + 1 !== shared.totalRounds) return undefined;

    if (this.control.terminalOutcome === 'throws') {
      throw new Error('reflection round threw');
    } else if (this.control.terminalOutcome === RUN_OUTCOME.FAILED) {
      shared.lastError = {
        message: 'reflection round failed',
        userRetryable: false,
      };
      shared.continueRounds = false;
    } else if (this.control.terminalOutcome === RUN_OUTCOME.CANCELLED) {
      this.control.abortController.abort();
    }

    return undefined;
  }
}

describe('RoundPersistedFlow round outcome persistence (#8137)', () => {
  it.each([
    {
      name: 'completed',
      terminalOutcome: RUN_OUTCOME.COMPLETED,
      persistedOutcome: RUN_OUTCOME.COMPLETED,
    },
    {
      name: 'failed',
      terminalOutcome: RUN_OUTCOME.FAILED,
      persistedOutcome: RUN_OUTCOME.FAILED,
    },
    {
      name: 'cancelled',
      terminalOutcome: RUN_OUTCOME.CANCELLED,
      persistedOutcome: RUN_OUTCOME.CANCELLED,
    },
    {
      name: 'thrown failure',
      terminalOutcome: 'throws' as const,
      persistedOutcome: RUN_OUTCOME.FAILED,
    },
  ])(
    'persists completed transition and $name final-round GROUP_END outcomes',
    async ({ name, terminalOutcome, persistedOutcome }) => {
      const kv = createFakeKv();
      const logger = new TraceEmitter();
      const streamId = `stream:reflection-round-${name}` as StreamTabId;
      const store = StreamLogStore.ephemeral('test');
      const control: OutcomeControl = {
        terminalOutcome,
        abortController: new AbortController(),
      };
      const flow = new RoundPersistedFlow<OutcomeShared>(
        new OutcomeRoundNode(control),
        kv,
        {
          callbacks: {
            createRoundStage: (roundIndex, parent, shared) =>
              logger.openStage(`r${roundIndex}`, {
                parent: parent ?? undefined,
                kind: 'round',
                index: roundIndex,
                total: shared.totalRounds,
              }),
            signal: control.abortController.signal,
          },
        },
      );
      const shared: OutcomeShared = {
        currentRound: 0,
        totalRounds: 2,
        continueRounds: true,
      };

      store.ensureStream(streamId);
      const recorder = attachTranscriptRecorder(
        logger,
        store.acquireWriter(streamId, streamId),
      );

      try {
        const run = flow.run(shared);
        if (terminalOutcome === 'throws') {
          await expect(run).rejects.toThrow('reflection round threw');
        } else {
          await expect(run).resolves.toBe(terminalOutcome);
        }

        const roundEndStatuses =
          store
            .get(streamId)
            ?.getRange(0)
            .flatMap((entry) => {
              if (
                entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END &&
                isObject(entry.data) &&
                entry.data.kind === 'round'
              ) {
                return [entry.data.status];
              }
              return [];
            }) ?? [];

        expect(roundEndStatuses).toEqual([
          RUN_OUTCOME.COMPLETED,
          persistedOutcome,
        ]);
      } finally {
        recorder.unsubscribe();
      }
    },
  );
});
