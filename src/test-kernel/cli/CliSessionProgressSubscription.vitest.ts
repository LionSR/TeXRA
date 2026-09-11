import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  attachCliSessionProgressProjection,
  type CliNdjsonProgressRecordWriter,
} from '@cli/runtime/sessionProgressSubscription';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  aggregateId as qualifyAggregateId,
  RUN_PHASE,
  RUN_SUBSTATE,
  AgentCategory,
  type ActiveChildInfo,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { RUN_TRANSITION_CAUSE } from '@shared/runs/runStatus';
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
 * expects the fact it published back, envelope aside (the row may carry
 * fields the publisher filled in, such as a trace arm's `transcriptDebug`).
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
        type: 'status',
        aggregateId: runAggregate,
        phase: RUN_PHASE.RUNNING,
        cause: RUN_TRANSITION_CAUSE.RESUME,
        previousPhase: RUN_PHASE.WAITING,
        substate: RUN_SUBSTATE.RESUMING,
      },
    },
    event: 'status',
    payload: {
      aggregateId: runAggregate,
      phase: RUN_PHASE.RUNNING,
      cause: RUN_TRANSITION_CAUSE.RESUME,
      previousPhase: RUN_PHASE.WAITING,
      substate: RUN_SUBSTATE.RESUMING,
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

type RosterListener = (
  parentRunId: RunId,
  items: readonly ActiveChildInfo[],
) => void;

function projectionOver(session: SessionHandle) {
  const writeRecord = recordWriter();
  let roster: RosterListener | undefined;
  const detach = attachCliSessionProgressProjection(
    {
      events: session.events,
      now: () => session.now(),
      runs: {
        onChildActivity: (listener: RosterListener) => {
          roster = listener;
          return () => {
            roster = undefined;
          };
        },
      },
    },
    writeRecord,
  );
  const publish = async (source: Source): Promise<void> => {
    if ('run' in source) session.publishRunEvent(runId, source.run);
    else session.publish([source.draft]);
    await session.settlePublications();
  };
  const records = (): CliNdjsonRecord[] =>
    vi.mocked(writeRecord).mock.calls.map(([record]) => record);
  return {
    writeRecord,
    records,
    publish,
    emitRoster: (parent: RunId, items: readonly ActiveChildInfo[]) =>
      roster?.(parent, items),
    detach,
  };
}

describe('attachCliSessionProgressProjection', () => {
  it('writes every display row as a progress record carrying the row verbatim', async () => {
    const session = createTestSession();
    publishTestRunStart(session, runId);
    publishTestRunStart(session, childRunId, { parent: runId });
    // The projection attaches at the current ordinal: settle the seeded
    // existence facts first so only what the test publishes is projected.
    await session.settlePublications();
    const { records, publish, detach } = projectionOver(session);
    try {
      for (const { source } of PASS_THROUGH_CASES) {
        await publish(source);
      }

      expect(records().map(rowFields)).toMatchObject(
        PASS_THROUGH_CASES.map(({ event, payload }) => ({
          event,
          fields: payload,
        })),
      );
    } finally {
      detach();
    }
  });

  it('carries the parent edge on run.start and the terminal fact on run.end', async () => {
    const session = createTestSession();
    publishTestRunStart(session, runId);
    await session.settlePublications();
    const { records, publish, detach } = projectionOver(session);
    try {
      await publish({
        draft: {
          type: 'run.start',
          aggregateId: childAggregate,
          identity: { kind: 'process', tool: 'bash' },
          category: AgentCategory.ToolUse,
          isRemote: false,
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          parent: { id: runId },
        },
      });
      await publish({
        draft: {
          type: 'run.end',
          aggregateId: childAggregate,
          outcome: 'completed',
          output: { category: 'toolUse', response: '', files: [] },
        },
      });

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
    } finally {
      detach();
    }
  });

  it('attaches at the current ordinal: a recorded session resumes with one activation line and no replayed history', async () => {
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
    ]);
    await session.settlePublications();

    const { records, publish, detach } = projectionOver(session);
    try {
      // A resume mints no run.start: the activation is its only new fact.
      await publish({
        draft: {
          type: 'run.activate',
          aggregateId: runAggregate,
          category: AgentCategory.ToolUse,
          isRemote: false,
        },
      });

      expect(records().map(rowFields)).toEqual([
        {
          event: 'run.activate',
          fields: {
            aggregateId: runAggregate,
            category: AgentCategory.ToolUse,
            isRemote: false,
          },
        },
      ]);
    } finally {
      detach();
    }
  });

  it('writes the child roster as a run.children record with the rows verbatim', async () => {
    const items: ActiveChildInfo[] = [
      {
        childRunId: 'run:native' as RunId,
        agentName: 'review',
        identity: { kind: 'agent', agent: 'review' },
        status: RUN_PHASE.RUNNING,
      },
      {
        childRunId: 'run:workflow' as RunId,
        agentName: 'plan',
        identity: { kind: 'multiAgentWorkflow', workflowName: 'delegate' },
        status: RUN_PHASE.RUNNING,
      },
      {
        childRunId: 'run:process' as RunId,
        agentName: 'bash',
        identity: { kind: 'process', tool: 'bash' },
        status: RUN_PHASE.RUNNING,
      },
    ];
    const session = createTestSession();
    publishTestRunStart(session, runId);
    await session.settlePublications();
    const { writeRecord, records, emitRoster, detach } =
      projectionOver(session);
    try {
      emitRoster(runId, items);
      await session.settlePublications();
      expect(writeRecord).toHaveBeenCalledTimes(1);
      expect(records()[0]).toEqual({
        kind: 'progress',
        event: 'run.children',
        ts: expect.any(String),
        payload: { runId, children: items },
      });
    } finally {
      detach();
    }
  });

  it('writes nothing after detach', async () => {
    const session = createTestSession();
    publishTestRunStart(session, runId);
    await session.settlePublications();
    const { writeRecord, publish, detach } = projectionOver(session);
    await publish({
      draft: {
        type: 'run.description',
        aggregateId: runAggregate,
        description: 'Proofread the introduction',
      },
    });
    expect(writeRecord).toHaveBeenCalledTimes(1);

    detach();
    await session.settlePublications();
    await publish({
      draft: {
        type: 'run.description',
        aggregateId: runAggregate,
        description: 'after detach',
      },
    });
    expect(writeRecord).toHaveBeenCalledTimes(1);
  });

  it('writes one record per published status fact without renderer dedup', async () => {
    const session = createTestSession();
    publishTestRunStart(session, runId);
    await session.settlePublications();
    const { records, publish, detach } = projectionOver(session);
    try {
      for (const substate of [RUN_SUBSTATE.RESUMING, RUN_SUBSTATE.STARTING]) {
        await publish({
          draft: {
            type: 'status',
            aggregateId: runAggregate,
            phase: RUN_PHASE.RUNNING,
            cause: RUN_TRANSITION_CAUSE.RESUME,
            previousPhase: RUN_PHASE.WAITING,
            substate,
          },
        });
      }

      expect(
        records().map((record) => rowFields(record).fields.substate),
      ).toEqual([RUN_SUBSTATE.RESUMING, RUN_SUBSTATE.STARTING]);
    } finally {
      detach();
    }
  });
});
