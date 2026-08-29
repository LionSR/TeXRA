// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { TraceEmitter } from '@agent/trace';
import { BaseNode } from '@agent/node';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
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
 * Regression coverage for the workflow round limit. Compile-failure feedback
 * may reach a remaining configured round, but it must never create a round
 * beyond totalRounds.
 */

interface FakeShared extends RoundAwareState {
  /** Round indices actually executed, in order. */
  roundsRun: number[];
  /** compileFailureContext observed by each executed round, if any. */
  contextSeenByRound: Record<number, string | undefined>;
  /** Round indices that should simulate a compile failure. */
  failingRounds: number[];
  /** Mirrors OutputNode's compile-failure context (set on failure, consumed next round). */
  compileFailureContext?: string;
}

/**
 * A single node standing in for the whole reflection round (PrepareContext +
 * ... + OutputNode). It records the round and consumes prior compile feedback,
 * then sets fresh feedback when the current round fails compilation.
 */
class FakeRoundNode extends BaseNode<FakeShared> {
  override async post(shared: FakeShared): Promise<undefined> {
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

class UnexpectedRoundNode extends BaseNode<FakeShared> {
  override async post(): Promise<never> {
    throw new Error('resumed from the start instead of the persisted cursor');
  }
}

function makeFlow(kv = createFakeKv()) {
  const node = new FakeRoundNode();
  const logger = new TraceEmitter();
  /** `{ index, total }` each round stage opened with, in call order. */
  const stages: Array<{ index: number; total: number }> = [];
  const flow = new RoundPersistedFlow<FakeShared>(node, kv, {
    callbacks: {
      createRoundStage: (roundIndex, parent, shared) => {
        const stage = { index: roundIndex, total: shared.totalRounds };
        stages.push(stage);
        return logger.openStage(`r${roundIndex}`, {
          parent: parent ?? undefined,
          kind: 'round',
          ...stage,
        });
      },
    },
  });
  return { flow, stages };
}

function initialShared(overrides: Partial<FakeShared>): FakeShared {
  return {
    currentRound: 0,
    totalRounds: 2,
    continueRounds: true,
    roundsRun: [],
    contextSeenByRound: {},
    failingRounds: [],
    ...overrides,
  };
}

async function runFlow(overrides: Partial<FakeShared>): Promise<{
  shared: FakeShared;
  stages: Array<{ index: number; total: number }>;
}> {
  const { flow, stages } = makeFlow();
  await flow.run(initialShared(overrides));
  return { shared: (await flow.getShared())!, stages };
}

async function expectFlowDidNotResume(
  flow: RoundPersistedFlow<FakeShared>,
  kv: ReturnType<typeof createFakeKv>,
  stages: unknown[],
): Promise<void> {
  expect((await flow.getShared())?.roundsRun).toEqual([]);
  expect(stages).toEqual([]);
  await expect(
    kv.read<FlowRecord>(flowKey(kv.getExecutionId())),
  ).resolves.toMatchObject({ cursor: { nextNodeId: 'start' } });
}

describe('RoundPersistedFlow compile-failure round limit', () => {
  it('passes compile-failure feedback into a remaining configured round', async () => {
    const { shared } = await runFlow({ failingRounds: [0] });

    expect(shared.roundsRun).toEqual([0, 1]);
    expect(shared.contextSeenByRound[1]).toBe('compile failed on round 0');
  });

  it('does not exceed the configured count when every round fails to compile', async () => {
    const { shared, stages } = await runFlow({
      totalRounds: 3,
      failingRounds: [0, 1, 2],
    });

    expect(shared.roundsRun).toEqual([0, 1, 2]);
    expect(shared.contextSeenByRound).toEqual({
      0: undefined,
      1: 'compile failed on round 0',
      2: 'compile failed on round 1',
    });
    expect(stages).toEqual([
      { index: 0, total: 3 },
      { index: 1, total: 3 },
      { index: 2, total: 3 },
    ]);
  });

  it('does not add a repair round after the final configured round fails', async () => {
    const { shared } = await runFlow({ failingRounds: [1] });

    expect(shared.roundsRun).toEqual([0, 1]);
    expect(shared.compileFailureContext).toBe('compile failed on round 1');
  });

  it('does not resume a persisted legacy repair round at the configured limit', async () => {
    const kv = createFakeKv();
    const { flow, stages } = makeFlow(kv);
    const persisted = initialShared({
      currentRound: 2,
      totalRounds: 2,
      compileFailureContext: 'compile failed on round 1',
    });
    await kv.write(flowKey(kv.getExecutionId()), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: { ...persisted, compileRepairRoundGranted: true },
      cursor: { nextNodeId: 'start' },
    } satisfies FlowRecord);

    await expect(flow.run(persisted)).resolves.toBe(RUN_OUTCOME.COMPLETED);

    await expectFlowDidNotResume(flow, kv, stages);
  });

  it('does not resume a persisted round excluded by a lowered round count', async () => {
    const kv = createFakeKv();
    const { flow, stages } = makeFlow(kv);
    const persisted = initialShared({ currentRound: 1, totalRounds: 3 });
    await kv.write(flowKey(kv.getExecutionId()), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: persisted,
      cursor: { nextNodeId: 'start' },
    } satisfies FlowRecord);
    const synced = { ...persisted, totalRounds: 1 };
    await flow.setShared(synced);

    await expect(flow.run(synced)).resolves.toBe(RUN_OUTCOME.COMPLETED);

    await expectFlowDidNotResume(flow, kv, stages);
  });

  it('still resumes a valid persisted cursor within the configured limit', async () => {
    const kv = createFakeKv();
    const start = new UnexpectedRoundNode();
    start.on('resume', new FakeRoundNode());
    const stages: number[] = [];
    const flow = new RoundPersistedFlow<FakeShared>(start, kv, {
      callbacks: {
        createRoundStage: (roundIndex) => {
          stages.push(roundIndex);
          return new TraceEmitter().openStage(`r${roundIndex}`);
        },
      },
    });
    const persisted = initialShared({ currentRound: 1, totalRounds: 2 });
    await kv.write(flowKey(kv.getExecutionId()), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: persisted,
      cursor: { nextNodeId: 'start/resume', lastAction: 'resume' },
    } satisfies FlowRecord);

    await expect(flow.run(persisted)).resolves.toBe(RUN_OUTCOME.COMPLETED);

    expect((await flow.getShared())?.roundsRun).toEqual([1]);
    expect(stages).toEqual([1]);
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

  override async post(shared: OutcomeShared): Promise<undefined> {
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
