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
  /** Round indices with an explicit successful compile result. */
  successfulRounds: number[];
  /** Round indices after which execution should be cancelled. */
  cancellingRounds: number[];
  /** Durable rejection, separate from one-shot prompt feedback. */
  unresolvedCompileRejection?: boolean;
}

/**
 * A single node standing in for the whole reflection round (PrepareContext +
 * ... + OutputNode). It records the round and consumes prior compile feedback,
 * then sets fresh feedback when the current round fails compilation.
 */
class FakeRoundNode extends BaseNode<FakeShared> {
  constructor(private readonly abortController?: AbortController) {
    super();
  }

  override async post(shared: FakeShared): Promise<undefined> {
    shared.roundsRun.push(shared.currentRound);
    shared.contextSeenByRound[shared.currentRound] =
      shared.compileFailureContext;
    delete shared.compileFailureContext;

    if (shared.failingRounds.includes(shared.currentRound)) {
      shared.compileFailureContext = `compile failed on round ${shared.currentRound}`;
      shared.unresolvedCompileRejection = true;
    } else if (shared.successfulRounds.includes(shared.currentRound)) {
      delete shared.unresolvedCompileRejection;
    }
    if (shared.cancellingRounds.includes(shared.currentRound)) {
      this.abortController?.abort();
    }
    return undefined;
  }
}

class UnexpectedRoundNode extends BaseNode<FakeShared> {
  override async post(): Promise<never> {
    throw new Error('resumed from the start instead of the persisted cursor');
  }
}

class ConsumeCompileFeedbackNode extends BaseNode<FakeShared> {
  override async post(shared: FakeShared): Promise<undefined> {
    delete shared.compileFailureContext;
    return undefined;
  }
}

class CrashingRoundNode extends BaseNode<FakeShared> {
  override async post(): Promise<never> {
    throw new Error('crashed after prompt preparation');
  }
}

class DisableRejectionDuringFinalRepairNode extends BaseNode<FakeShared> {
  constructor(private readonly policy: { enabled: boolean }) {
    super();
  }

  override async post(shared: FakeShared): Promise<undefined> {
    shared.roundsRun.push(shared.currentRound);
    if (shared.currentRound === 0) {
      shared.compileFailureContext = 'compile failed on round 0';
      shared.unresolvedCompileRejection = true;
    } else {
      delete shared.compileFailureContext;
      this.policy.enabled = false;
    }
    return undefined;
  }
}

function makeFlow(kv = createFakeKv(), rejectOnCompileFailure = true) {
  const abortController = new AbortController();
  const node = new FakeRoundNode(abortController);
  const logger = new TraceEmitter();
  /** `{ index, total }` each round stage opened with, in call order. */
  const stages: Array<{ index: number; total: number }> = [];
  const flow = new RoundPersistedFlow<FakeShared>(node, kv, {
    getRejectOnCompileFailure: () => rejectOnCompileFailure,
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
      signal: abortController.signal,
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
    successfulRounds: [0, 1, 2],
    cancellingRounds: [],
    ...overrides,
  };
}

async function runFlow(
  overrides: Partial<FakeShared>,
  rejectOnCompileFailure = true,
): Promise<{
  shared: FakeShared;
  stages: Array<{ index: number; total: number }>;
  outcome: RunOutcome;
}> {
  const { flow, stages } = makeFlow(undefined, rejectOnCompileFailure);
  const outcome = await flow.run(initialShared(overrides));
  return { shared: (await flow.getShared())!, stages, outcome };
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
  it('completes after an explicit compile success resolves a prior rejection', async () => {
    const { shared, outcome } = await runFlow({ failingRounds: [0] });

    expect(shared.roundsRun).toEqual([0, 1]);
    expect(shared.contextSeenByRound[1]).toBe('compile failed on round 0');
    expect(shared.unresolvedCompileRejection).toBeUndefined();
    expect(outcome).toBe(RUN_OUTCOME.COMPLETED);
  });

  it('fails a single-round run with an unresolved compile rejection', async () => {
    const { shared, outcome } = await runFlow({
      totalRounds: 1,
      failingRounds: [0],
    });

    expect(shared.roundsRun).toEqual([0]);
    expect(shared.unresolvedCompileRejection).toBe(true);
    expect(shared.lastError).toBeUndefined();
    expect(outcome).toBe(RUN_OUTCOME.FAILED);
  });

  it('fails when the final round has no compile result after prior rejection', async () => {
    const { shared, outcome } = await runFlow({
      failingRounds: [0],
      successfulRounds: [],
    });

    expect(shared.roundsRun).toEqual([0, 1]);
    expect(shared.contextSeenByRound[1]).toBe('compile failed on round 0');
    expect(shared.compileFailureContext).toBeUndefined();
    expect(shared.unresolvedCompileRejection).toBe(true);
    expect(outcome).toBe(RUN_OUTCOME.FAILED);
  });

  it('cancels when non-final compile feedback cannot reach the next round', async () => {
    const { shared, outcome } = await runFlow({
      totalRounds: 3,
      failingRounds: [0],
      cancellingRounds: [0],
    });

    expect(shared.roundsRun).toEqual([0]);
    expect(shared.compileFailureContext).toBe('compile failed on round 0');
    expect(shared.unresolvedCompileRejection).toBe(true);
    expect(outcome).toBe(RUN_OUTCOME.CANCELLED);
  });

  it('does not exceed the configured count when every round fails to compile', async () => {
    const { shared, stages, outcome } = await runFlow({
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
    expect(outcome).toBe(RUN_OUTCOME.FAILED);
  });

  it('does not complete when cancellation lands after prompt feedback was consumed', async () => {
    const { shared, outcome } = await runFlow({
      failingRounds: [0],
      successfulRounds: [],
      cancellingRounds: [1],
    });

    expect(shared.roundsRun).toEqual([0, 1]);
    expect(shared.contextSeenByRound[1]).toBe('compile failed on round 0');
    expect(shared.compileFailureContext).toBeUndefined();
    expect(shared.unresolvedCompileRejection).toBe(true);
    expect(outcome).toBe(RUN_OUTCOME.FAILED);
  });

  it('persists unresolved rejection when execution crashes after prompt consumption', async () => {
    const kv = createFakeKv();
    const prepare = new ConsumeCompileFeedbackNode();
    prepare.next(new CrashingRoundNode());
    const flow = new RoundPersistedFlow<FakeShared>(prepare, kv, {
      getRejectOnCompileFailure: () => true,
    });
    const shared = initialShared({
      currentRound: 1,
      totalRounds: 2,
      compileFailureContext: 'compile failed on round 0',
      unresolvedCompileRejection: true,
    });

    await expect(flow.run(shared)).rejects.toThrow(
      'crashed after prompt preparation',
    );

    expect((await flow.getShared())?.compileFailureContext).toBeUndefined();
    expect((await flow.getShared())?.unresolvedCompileRejection).toBe(true);
  });

  it('accepts a recorded rejection when policy is disabled during a final repair with no compile result', async () => {
    const kv = createFakeKv();
    const policy = { enabled: true };
    const flow = new RoundPersistedFlow<FakeShared>(
      new DisableRejectionDuringFinalRepairNode(policy),
      kv,
      { getRejectOnCompileFailure: () => policy.enabled },
    );

    await expect(flow.run(initialShared({}))).resolves.toBe(
      RUN_OUTCOME.COMPLETED,
    );

    expect((await flow.getShared())?.roundsRun).toEqual([0, 1]);
    expect((await flow.getShared())?.compileFailureContext).toBeUndefined();
    expect(
      (await flow.getShared())?.unresolvedCompileRejection,
    ).toBeUndefined();
  });

  it('deactivates persisted rejection before the cap guard when rejection is disabled', async () => {
    const kv = createFakeKv();
    const { flow, stages } = makeFlow(kv, false);
    const persisted = initialShared({
      currentRound: 1,
      totalRounds: 1,
      compileFailureContext: 'compile failed on round 0',
      unresolvedCompileRejection: true,
    });
    await kv.write(flowKey(kv.getExecutionId()), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: persisted,
      cursor: { nextNodeId: 'start' },
    } satisfies FlowRecord);

    await expect(flow.run(persisted)).resolves.toBe(RUN_OUTCOME.COMPLETED);

    expect((await flow.getShared())?.compileFailureContext).toBeUndefined();
    expect(
      (await flow.getShared())?.unresolvedCompileRejection,
    ).toBeUndefined();
    expect(stages).toEqual([]);
  });

  it('does not resume a persisted legacy repair round at the configured limit', async () => {
    const kv = createFakeKv();
    const { flow, stages } = makeFlow(kv);
    const persisted = initialShared({
      currentRound: 2,
      totalRounds: 2,
      compileFailureContext: 'compile failed on round 1',
      unresolvedCompileRejection: true,
    });
    await kv.write(flowKey(kv.getExecutionId()), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: { ...persisted, compileRepairRoundGranted: true },
      cursor: { nextNodeId: 'start' },
    } satisfies FlowRecord);

    await expect(flow.run(persisted)).resolves.toBe(RUN_OUTCOME.FAILED);

    await expectFlowDidNotResume(flow, kv, stages);
  });

  it('fails unresolved rejection when a resumed round cap is lowered', async () => {
    const kv = createFakeKv();
    const { flow, stages } = makeFlow(kv);
    const persisted = initialShared({
      currentRound: 1,
      totalRounds: 3,
      unresolvedCompileRejection: true,
    });
    await kv.write(flowKey(kv.getExecutionId()), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: persisted,
      cursor: { nextNodeId: 'start' },
    } satisfies FlowRecord);
    const synced = { ...persisted, totalRounds: 1 };
    await flow.setShared(synced);

    await expect(flow.run(synced)).resolves.toBe(RUN_OUTCOME.FAILED);

    await expectFlowDidNotResume(flow, kv, stages);
  });

  it('allows a raised cap to resolve persisted rejection with explicit success', async () => {
    const kv = createFakeKv();
    const { flow, stages } = makeFlow(kv);
    const persisted = initialShared({
      currentRound: 0,
      totalRounds: 1,
      compileFailureContext: 'compile failed on round 0',
      unresolvedCompileRejection: true,
    });
    await kv.write(flowKey(kv.getExecutionId()), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: persisted,
      cursor: { nextNodeId: null },
    } satisfies FlowRecord);
    const synced = { ...persisted, totalRounds: 2 };
    await flow.setShared(synced);

    await expect(flow.run(synced)).resolves.toBe(RUN_OUTCOME.COMPLETED);

    expect(
      (await flow.getShared())?.unresolvedCompileRejection,
    ).toBeUndefined();
    expect(stages).toEqual([
      { index: 0, total: 2 },
      { index: 1, total: 2 },
    ]);
  });

  it('still resumes a valid persisted cursor within the configured limit', async () => {
    const kv = createFakeKv();
    const start = new UnexpectedRoundNode();
    start.on('resume', new FakeRoundNode());
    const stages: number[] = [];
    const flow = new RoundPersistedFlow<FakeShared>(start, kv, {
      getRejectOnCompileFailure: () => true,
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
          getRejectOnCompileFailure: () => true,
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
