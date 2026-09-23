import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

import type { AgentEvent } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  attachCliSessionProgressProjection,
  type CliNdjsonProgressRecordWriter,
} from '@cli/runtime/sessionProgressSubscription';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

const runId = 'c11a01' as RunId;
const childRunId = 'c11c01' as RunId;
/** The run a usage report is keyed by: a child's spend on its parent's map. */
const usageRunId = 'a00101' as RunId;
const runAggregate = qualifyAggregateId('run', runId);
const childAggregate = qualifyAggregateId('run', childRunId);

/** A published fact: a run-scoped trace event on `runId`, or a draft. */
type Source =
  { readonly run: AgentEvent } | { readonly draft: SessionEventDraft };

const inquiryThread = {
  threadId: 'ei_123456789abc',
  status: 'open' as const,
  lastQuestionPreview: 'Which boundary condition is intended?',
  lastActivityIso: '2026-07-10T12:00:00.000Z',
  turnCount: 1,
};
const usage = { inputTokens: 10, outputTokens: 20, cost: 0.01 };

/**
 * Version 2 carries the session row itself: `event` is the row's `type`,
 * `payload` the rest of the row under its own field names, so each case
 * expects the fact it published back, envelope aside.
 */
const PASS_THROUGH_CASES: ReadonlyArray<{
  readonly source: Source;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}> = [
  {
    source: {
      draft: {
        type: 'run.activate',
        aggregateId: runAggregate,
        category: AgentCategory.Workflow,
        isRemote: false,
      },
    },
    event: 'run.activate',
    payload: {
      aggregateId: runAggregate,
      category: AgentCategory.Workflow,
      isRemote: false,
    },
  },
  {
    source: {
      draft: {
        type: 'flow.step',
        aggregateId: runAggregate,
        payload: { family: 'toolUse', step: 'turn.begin', round: 1, turn: 2 },
      },
    },
    event: 'flow.step',
    payload: {
      aggregateId: runAggregate,
      payload: { family: 'toolUse', step: 'turn.begin', round: 1, turn: 2 },
    },
  },
  {
    source: { run: { type: 'usage', runId: usageRunId, usage } },
    event: 'usage',
    payload: { aggregateId: runAggregate, runId: usageRunId, usage },
  },
  {
    source: {
      run: {
        type: 'stage.start',
        id: 'round-2',
        label: 'Round 3',
        kind: 'round',
        index: 2,
        total: 4,
      },
    },
    event: 'stage.start',
    payload: {
      aggregateId: runAggregate,
      id: 'round-2',
      label: 'Round 3',
      kind: 'round',
      index: 2,
      total: 4,
    },
  },
  {
    source: {
      draft: {
        type: 'inquiryThreadUpdated',
        aggregateId: qualifyAggregateId('inquiry', inquiryThread.threadId),
        ...inquiryThread,
        parentRunId: runId,
      },
    },
    event: 'inquiryThreadUpdated',
    payload: {
      aggregateId: qualifyAggregateId('inquiry', inquiryThread.threadId),
      ...inquiryThread,
      parentRunId: runId,
    },
  },
  {
    source: {
      draft: {
        type: 'run.description',
        aggregateId: runAggregate,
        description: 'Checking the compactness lemma',
      },
    },
    event: 'run.description',
    payload: {
      aggregateId: runAggregate,
      description: 'Checking the compactness lemma',
    },
  },
  {
    source: { draft: { type: 'run.detach', aggregateId: childAggregate } },
    event: 'run.detach',
    payload: { aggregateId: childAggregate },
  },
  {
    source: { draft: { type: 'run.removed', aggregateId: childAggregate } },
    event: 'run.removed',
    payload: { aggregateId: childAggregate },
  },
];

function recordWriter(): CliNdjsonProgressRecordWriter {
  return vi.fn() as CliNdjsonProgressRecordWriter;
}

/** The row's own fields: the commit envelope is the log's, asserted apart. */
function rowFields(record: CliNdjsonRecord): {
  readonly event: unknown;
  readonly fields: Record<string, unknown>;
} {
  expect(record.kind).toBe('progress');
  expect(record.ts).toEqual(expect.any(String));
  const { seq, commit, ownerId, at, ...fields } = record.payload as Record<
    string,
    unknown
  >;
  expect(seq).toEqual(expect.any(Number));
  expect(commit).toEqual(expect.any(Number));
  expect(ownerId === null || typeof ownerId === 'string').toBe(true);
  expect(at).toEqual(expect.any(Number));
  return { event: record.event, fields };
}

function projectionOver(session: SessionHandle) {
  const writeRecord = recordWriter();
  const detachProjection = attachCliSessionProgressProjection(
    testRuntime(),
    session,
    writeRecord,
  );
  const publish = async (source: Source): Promise<void> => {
    if ('run' in source) session.publishRunEvent(runId, source.run);
    else session.publish([source.draft]);
    await Effect.runPromise(session.settlePublications());
  };
  const all = (): CliNdjsonRecord[] =>
    vi.mocked(writeRecord).mock.calls.map(([record]) => record);
  /** The event lines alone: the roster is a derivation, asserted apart. */
  const records = (): CliNdjsonRecord[] =>
    all().filter((record) => record.event !== 'run.children');
  /** The projection's drain, run for the suite's Promise-shaped tests. */
  const detach = (): Promise<void> => Effect.runPromise(detachProjection());
  return { writeRecord, all, records, publish, detach };
}

describe('attachCliSessionProgressProjection', () => {
  it.effect(
    'writes every display row as a progress record carrying the row verbatim',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        publishTestRunStart(session, runId);
        publishTestRunStart(session, childRunId, { parent: runId });
        // The projection attaches at the current ordinal: settle the seeded
        // existence facts first so only what the test publishes is projected.
        yield* session.settlePublications();
        const { records, publish, detach } = projectionOver(session);
        yield* Effect.addFinalizer(() => Effect.promise(() => detach()));
        for (const { source } of PASS_THROUGH_CASES) {
          yield* Effect.promise(() => publish(source));
        }

        expect(records().map(rowFields)).toMatchObject(
          PASS_THROUGH_CASES.map(({ event, payload }) => ({
            event,
            fields: payload,
          })),
        );
      }),
  );

  it.effect(
    'carries the parent edge on run.start and the terminal fact on run.end',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        publishTestRunStart(session, runId);
        yield* session.settlePublications();
        const { records, publish, detach } = projectionOver(session);
        yield* Effect.addFinalizer(() => Effect.promise(() => detach()));
        yield* Effect.promise(() =>
          publish({
            draft: {
              type: 'run.start',
              aggregateId: childAggregate,
              identity: { kind: 'process', tool: 'bash' },
              category: AgentCategory.ToolUse,
              isRemote: false,
              userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
              parent: { id: runId },
            },
          }),
        );
        yield* Effect.promise(() =>
          publish({
            draft: {
              type: 'run.end',
              aggregateId: childAggregate,
              outcome: 'completed',
              output: { category: 'toolUse', response: '', files: [] },
            },
          }),
        );

        const [start, end] = records().map(rowFields);
        expect(start).toEqual({
          event: 'run.start',
          fields: expect.objectContaining({
            aggregateId: childAggregate,
            identity: { kind: 'process', tool: 'bash' },
            parent: expect.objectContaining({ id: runId }),
          }),
        });
        expect(end).toEqual({
          event: 'run.end',
          fields: expect.objectContaining({
            aggregateId: childAggregate,
            outcome: 'completed',
          }),
        });
      }),
  );

  it.effect(
    'attaches at the current ordinal: a recorded session resumes with one activation line and no replayed history',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        // The recorded history: a launch that ran and stopped before this
        // process attached its projection.
        session.publish([
          {
            type: 'run.start',
            aggregateId: runAggregate,
            identity: { kind: 'agent', agent: 'polish' },
            category: AgentCategory.ToolUse,
            isRemote: false,
            userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
            parent: null,
          },
          {
            type: 'run.activate',
            aggregateId: runAggregate,
            category: AgentCategory.ToolUse,
            isRemote: false,
          },
          {
            type: 'run.description',
            aggregateId: runAggregate,
            description: 'Recorded before the resume',
          },
          // A child that ran and settled before the resume: its parent's
          // roster is history too, not a line to replay (#11864).
          {
            type: 'run.start',
            aggregateId: childAggregate,
            identity: { kind: 'agent', agent: 'review' },
            category: AgentCategory.ToolUse,
            isRemote: false,
            userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
            parent: { id: runId },
          },
          {
            type: 'run.end',
            aggregateId: childAggregate,
            outcome: 'completed',
            output: { category: 'toolUse', response: '', files: [] },
          },
        ]);
        yield* session.settlePublications();

        const { all, publish, detach } = projectionOver(session);
        yield* Effect.addFinalizer(() => Effect.promise(() => detach()));
        // A resume mints no run.start: the activation is its only new fact.
        yield* Effect.promise(() =>
          publish({
            draft: {
              type: 'run.activate',
              aggregateId: runAggregate,
              category: AgentCategory.ToolUse,
              isRemote: false,
            },
          }),
        );
        yield* Effect.promise(() => detach());

        expect(all().map(rowFields)).toEqual([
          {
            event: 'run.activate',
            fields: {
              aggregateId: runAggregate,
              category: AgentCategory.ToolUse,
              isRemote: false,
            },
          },
        ]);
      }),
  );

  it.effect(
    'derives the child roster from the fold, one run.children record per change',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        publishTestRunStart(session, runId);
        yield* session.settlePublications();
        const { all, publish, detach } = projectionOver(session);
        yield* Effect.addFinalizer(() => Effect.promise(() => detach()));
        const rosters = () => all().filter((r) => r.event === 'run.children');
        yield* Effect.promise(() =>
          publish({
            draft: {
              type: 'run.start',
              aggregateId: childAggregate,
              identity: { kind: 'agent', agent: 'review' },
              category: AgentCategory.ToolUse,
              isRemote: false,
              userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
              parent: { id: runId },
            },
          }),
        );
        // The child's own row, under its own names, with the fold's phase:
        // `ready` until its `run.activate` folds.
        expect(rosters()).toEqual([
          {
            kind: 'progress',
            event: 'run.children',
            ts: expect.any(String),
            payload: {
              runId,
              children: [
                {
                  childRunId,
                  agentName: 'review',
                  identity: { kind: 'agent', agent: 'review' },
                  status: 'ready',
                },
              ],
            },
          },
        ]);

        // A row that moves the child's phase rewrites the roster once.
        yield* Effect.promise(() =>
          publish({
            draft: {
              type: 'run.activate',
              aggregateId: childAggregate,
              category: AgentCategory.ToolUse,
              isRemote: false,
            },
          }),
        );
        expect(rosters()).toHaveLength(2);
        expect(rosters()[1]?.payload).toMatchObject({
          runId,
          children: [{ childRunId, status: 'running' }],
        });

        // A row that moves nothing on the roster writes no second copy.
        yield* Effect.promise(() =>
          publish({
            draft: {
              type: 'run.description',
              aggregateId: runAggregate,
              description: 'Checking the compactness lemma',
            },
          }),
        );
        expect(rosters()).toHaveLength(2);

        // The ended child leaves the live roster; its own `run.end` line
        // carries the outcome.
        yield* Effect.promise(() =>
          publish({
            draft: {
              type: 'run.end',
              aggregateId: childAggregate,
              outcome: 'completed',
              output: { category: 'toolUse', response: '', files: [] },
            },
          }),
        );
        expect(rosters()).toHaveLength(3);
        expect(rosters()[2]?.payload).toEqual({ runId, children: [] });
      }),
  );

  it.effect('writes nothing after detach', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      publishTestRunStart(session, runId);
      yield* session.settlePublications();
      const { writeRecord, publish, detach } = projectionOver(session);
      yield* Effect.promise(() =>
        publish({
          draft: {
            type: 'run.description',
            aggregateId: runAggregate,
            description: 'Proofread the introduction',
          },
        }),
      );
      expect(writeRecord).toHaveBeenCalledTimes(1);

      yield* Effect.promise(() => detach());
      yield* session.settlePublications();
      yield* Effect.promise(() =>
        publish({
          draft: {
            type: 'run.description',
            aggregateId: runAggregate,
            description: 'after detach',
          },
        }),
      );
      expect(writeRecord).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    'writes one record per published flow step without renderer dedup',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        publishTestRunStart(session, runId);
        yield* session.settlePublications();
        const { records, publish, detach } = projectionOver(session);
        yield* Effect.addFinalizer(() => Effect.promise(() => detach()));
        for (const turn of [1, 2]) {
          yield* Effect.promise(() =>
            publish({
              draft: {
                type: 'flow.step',
                aggregateId: runAggregate,
                payload: {
                  family: 'toolUse',
                  step: 'turn.begin',
                  round: 1,
                  turn,
                },
              },
            }),
          );
        }

        expect(
          records().map((record) => rowFields(record).fields),
        ).toMatchObject([{ payload: { turn: 1 } }, { payload: { turn: 2 } }]);
      }),
  );
});
