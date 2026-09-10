import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  CliNdjsonProgressEvent,
  CliNdjsonProgressEventPayloads,
} from '@cli/runtime/cliNdjsonProgressEvents';
import {
  attachCliSessionProgressProjection,
  type CliNdjsonProgressRecordWriter,
} from '@cli/runtime/sessionProgressSubscription';
import {
  aggregateId as qualifyAggregateId,
  RUN_PHASE,
  RUN_SUBSTATE,
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  type ActiveChildInfo,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { RunId, RunId } from '@shared/schemas';
import {
  RUN_TRANSITION_CAUSE,
  type RunTransitionCause,
} from '@shared/runs/runStatus';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

const runId = 'stream:cli-session-projection' as RunId;
const runId = 'c11a01' as RunId;
const childRunId = 'stream:cli-child' as RunId;
const childRunId = 'c11c01' as RunId;
const storageKey = 'a00101' as RunId;

type WorkflowConfig = Omit<AgentConfig, 'agentCategory'> & {
  agentCategory: typeof AgentCategory.Workflow;
};

function workflowConfig(
  overrides: Partial<Omit<AgentConfig, 'agentCategory'>> = {},
): WorkflowConfig {
  return {
    agent: 'polish',
    agentCategory: AgentCategory.Workflow,
    model: 'deepseek-chat',
    inputFiles: ['paper.tex'],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    editedFile: null,
    editedFiles: [],
    instruction: '',
    toolConfig: DEFAULT_TOOL_CONFIG,
    memories: [],
    workingDirectory: '/tmp/project',
    ...overrides,
  };
}

type RunStatusProjectionPayload =
  CliNdjsonProgressEventPayloads['updateStreamStatus'] & {
    cause: RunTransitionCause;
  };

/** A published fact: a run-scoped trace event on `runId`, or a draft. */
type Source =
  { readonly run: AgentEvent } | { readonly draft: SessionEventDraft };

function runEvent(event: AgentEvent): Source {
  return { run: event };
}

function draft(draft: SessionEventDraft): Source {
  return { draft };
}

function statusDraft(payload: RunStatusProjectionPayload): Source {
  return draft({
    type: 'status',
    aggregateId: qualifyAggregateId('stream', payload.runId),
    phase: payload.status,
    cause: payload.cause,
    ...(payload.previousStatus
      ? { previousPhase: payload.previousStatus }
      : {}),
    ...(payload.substate ? { substate: payload.substate } : {}),
  });
}

type ProgressProjectionCases = {
  [K in Exclude<CliNdjsonProgressEvent, 'updateActiveSubagents'>]: {
    readonly source: Source;
    readonly payload: CliNdjsonProgressEventPayloads[K];
  };
};

const projectionConfig = workflowConfig({
  inputFiles: ['paper.tex', 'appendix.tex'],
  contextFiles: ['notes.md'],
});
const inquiryThread = {
  threadId: 'ei_123456789abc',
  parentRunId: runId,
  status: 'open' as const,
  lastQuestionPreview: 'Which boundary condition is intended?',
  lastActivityIso: '2026-07-10T12:00:00.000Z',
  turnCount: 1,
};

const PROGRESS_PROJECTION_CASES = {
  setActiveStream: {
    source: draft({
      type: 'run.activate',
      aggregateId: qualifyAggregateId('stream', runId),
      category: AgentCategory.Workflow,
      isRemote: false,
      background: false,
    }),
    payload: {
      runId,
      agentCategory: AgentCategory.Workflow,
      isRemote: false,
    },
  },
  updateStreamStatus: {
    source: statusDraft({
      runId,
      status: RUN_PHASE.RUNNING,
      cause: RUN_TRANSITION_CAUSE.LIFECYCLE,
    }),
    payload: {
      runId,
      status: RUN_PHASE.RUNNING,
      cause: RUN_TRANSITION_CAUSE.LIFECYCLE,
    },
  },
  addOutputFiles: {
    source: runEvent({
      type: 'addOutputFiles',
      runId,
      filesByRound: { 1: [] },
    }),
    payload: { runId, filesByRound: { 1: [] } },
  },
  updateMissingOutputs: {
    source: runEvent({
      type: 'updateMissingOutputs',
      runId,
      filesByRound: { 1: ['missing.tex'] },
    }),
    payload: {
      runId,
      filesByRound: { 1: ['missing.tex'] },
    },
  },
  updateCompileFailures: {
    source: runEvent({
      type: 'updateCompileFailures',
      runId,
      filesByRound: { 1: [] },
    }),
    payload: { runId, filesByRound: { 1: [] } },
  },
  setTaskState: {
    source: runEvent({
      type: 'run.config',
      runId,
      runId,
      config: projectionConfig,
    }),
    payload: {
      runId,
      runId,
      taskState: {
        agentConfig: projectionConfig,
        activeFiles: {
          input: true,
          context: true,
          media: false,
          output: false,
        },
      },
    },
  },
  updateStreamUsage: {
    source: runEvent({
      type: 'usage',
      payload: {
        runId,
        storageKey,
        usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
      },
    }),
    payload: {
      runId,
      storageKey,
      usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
    },
  },
  inquiryThreadUpdated: {
    source: draft({
      type: 'inquiryThreadUpdated',
      aggregateId: qualifyAggregateId('inquiry', inquiryThread.threadId),
      ...inquiryThread,
    }),
    payload: inquiryThread,
  },
  updateTodos: {
    source: runEvent({
      type: 'updateTodos',
      runId,
      todos: [
        {
          content: 'Check the compactness lemma.',
          status: 'pending',
          activeForm: 'Checking the compactness lemma.',
        },
      ],
    }),
    payload: {
      runId,
      todos: [
        {
          content: 'Check the compactness lemma.',
          status: 'pending',
          activeForm: 'Checking the compactness lemma.',
        },
      ],
    },
  },
  updatePlan: {
    source: runEvent({
      type: 'updatePlan',
      runId,
      plan: { objective: 'Check the compactness lemma.' },
    }),
    payload: {
      runId,
      plan: { objective: 'Check the compactness lemma.' },
    },
  },
  updateConversationProgress: {
    source: runEvent({
      type: 'conversation.progress',
      progress: { toolCallCount: 5 },
    }),
    payload: { runId, progress: { toolCallCount: 5 } },
  },
  updateRoundStage: {
    source: runEvent({
      type: 'stage.start',
      id: 'round-2',
      label: 'Round 3',
      kind: 'round',
      index: 2,
      total: 4,
    }),
    payload: { runId, roundStage: { index: 2, total: 4 } },
  },
  updateQueuedFollowUps: {
    source: draft({
      type: 'updateQueuedFollowUps',
      aggregateId: qualifyAggregateId('stream', runId),
      messages: ['queued'],
    }),
    payload: { runId },
  },
  goalPaused: {
    source: runEvent({ type: 'goalPaused', runId }),
    payload: { runId },
  },
  updateRunDescription: {
    source: draft({
      type: 'updateRunDescription',
      aggregateId: qualifyAggregateId('stream', runId),
      description: 'Checking the compactness lemma',
    }),
    payload: { runId, description: 'Checking the compactness lemma' },
  },
  setParentStream: {
    source: draft({
      type: 'setParentStream',
      aggregateId: qualifyAggregateId('stream', childRunId),
      parentRunId: runId,
    }),
    payload: { childRunId, parentRunId: runId },
  },
  removeRun: {
    source: draft({
      type: 'run.removed',
      aggregateId: qualifyAggregateId('stream', childRunId),
    }),
    payload: { runId: childRunId },
  },
  goalStateChanged: {
    source: draft({
      type: 'goalStateChanged',
      aggregateId: qualifyAggregateId('stream', runId),
      state: { active: false },
    }),
    payload: { runId },
  },
} satisfies ProgressProjectionCases;

function recordWriter(): CliNdjsonProgressRecordWriter {
  return vi.fn() as CliNdjsonProgressRecordWriter;
}

function progressRecord(event: string, payload: unknown) {
  return expect.objectContaining({
    kind: 'progress',
    event,
    ts: expect.any(String),
    payload,
  });
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
      executions: {
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
  return {
    writeRecord,
    publish,
    emitRoster: (parent: RunId, items: readonly ActiveChildInfo[]) =>
      roster?.(parent, items),
    hasRosterListener: () => roster !== undefined,
    detach,
  };
}

const resumingStatusPayload: RunStatusProjectionPayload = {
  runId,
  status: RUN_PHASE.RUNNING,
  previousStatus: RUN_PHASE.WAITING,
  cause: RUN_TRANSITION_CAUSE.RESUME,
  substate: RUN_SUBSTATE.RESUMING,
};

const activation: SessionEventDraft = {
  type: 'run.activate',
  aggregateId: qualifyAggregateId('stream', runId),
  category: AgentCategory.ToolUse,
  background: true,
};

describe('attachCliSessionProgressProjection', () => {
  it('projects one setActiveStream line per activation, byte-identical for a background child, and none from run.start', async () => {
    const { writeRecord, publish, detach } =
      projectionOver(createTestSession());
    try {
      // A launch: the existence fact projects nothing, its activation the
      // frozen line; a child's line never carried `isRemote`.
      await publish(
        draft({
          type: 'run.start',
          aggregateId: qualifyAggregateId('stream', runId),
          runId,
          identity: { kind: 'process', tool: 'bash' },
          category: AgentCategory.ToolUse,
          isRemote: false,
          userFollowUpSupport: 'unsupported',
          background: true,
        }),
      );
      await publish(draft(activation));
      await publish(draft(activation));

      const activations = vi
        .mocked(writeRecord)
        .mock.calls.filter(([record]) => record.event === 'setActiveStream');
      expect(activations).toHaveLength(2);
      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('setActiveStream', {
          runId,
          agentCategory: AgentCategory.ToolUse,
          suppressViewSwitch: true,
        }),
      );
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
        aggregateId: qualifyAggregateId('stream', runId),
        runId,
        identity: { kind: 'agent', agent: 'polish' },
        category: AgentCategory.ToolUse,
        isRemote: false,
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      },
      {
        type: 'run.activate',
        aggregateId: qualifyAggregateId('stream', runId),
        category: AgentCategory.ToolUse,
        isRemote: false,
        background: false,
      },
      {
        type: 'updateRunDescription',
        aggregateId: qualifyAggregateId('stream', runId),
        description: 'Recorded before the resume',
      },
    ]);
    await session.settlePublications();

    const { writeRecord, publish, detach } = projectionOver(session);
    try {
      // A resume mints no run.start: the activation is its only new fact.
      await publish(
        draft({
          type: 'run.activate',
          aggregateId: qualifyAggregateId('stream', runId),
          category: AgentCategory.ToolUse,
          isRemote: false,
          background: false,
        }),
      );
      await publish(statusDraft(resumingStatusPayload));

      expect(vi.mocked(writeRecord).mock.calls.map(([r]) => r)).toEqual([
        progressRecord('setActiveStream', {
          runId,
          agentCategory: AgentCategory.ToolUse,
          isRemote: false,
        }),
        progressRecord('updateStreamStatus', resumingStatusPayload),
      ]);
    } finally {
      detach();
    }
  });

  it('projects every public NDJSON progress event with its typed payload', async () => {
    const cases = Object.entries(PROGRESS_PROJECTION_CASES);
    const session = createTestSession();
    publishTestRunStart(session, runId, runId);
    publishTestRunStart(session, childRunId, childRunId);
    const { writeRecord, publish, detach } = projectionOver(session);
    try {
      for (const [, projection] of cases) {
        await publish(projection.source);
      }

      expect(
        vi.mocked(writeRecord).mock.calls.map(([record]) => record.event),
      ).toEqual(cases.map(([event]) => event));
      for (const [index, [event, projection]] of cases.entries()) {
        expect(writeRecord).toHaveBeenNthCalledWith(
          index + 1,
          progressRecord(event, projection.payload),
        );
      }
    } finally {
      detach();
    }
  });

  it('projects updateActiveSubagents rows byte-for-byte onto the frozen public shape', async () => {
    // One row per identity kind; `toEqual` (not objectContaining) pins the
    // exact pre-consolidation wire shape: `kind` discriminant, `toolName`
    // encoding, `childRunId` only on subagent rows, and NO `identity`.
    const items: ActiveChildInfo[] = [
      {
        runId: 'a101' as RunId,
        childRunId: 'stream:native' as RunId,
        agentName: 'review',
        identity: { kind: 'agent', agent: 'review' },
        status: RUN_PHASE.RUNNING,
      },
      {
        runId: 'a102' as RunId,
        childRunId: 'stream:tool' as RunId,
        agentName: 'polish',
        identity: { kind: 'agent', agent: 'polish', tool: 'delegate' },
        status: RUN_PHASE.RUNNING,
      },
      {
        runId: 'a103' as RunId,
        childRunId: 'stream:workflow' as RunId,
        agentName: 'plan',
        identity: { kind: 'multiAgentWorkflow', workflowName: 'delegate' },
        status: RUN_PHASE.RUNNING,
      },
      {
        runId: 'a104' as RunId,
        childRunId: 'stream:process' as RunId,
        agentName: 'bash',
        identity: { kind: 'process', tool: 'bash' },
        status: RUN_PHASE.RUNNING,
      },
    ];
    const session = createTestSession();
    publishTestRunStart(session, runId, runId);
    publishTestRunStart(session, childRunId, childRunId);
    const { writeRecord, emitRoster, detach } = projectionOver(session);
    try {
      emitRoster(runId, items);
      await session.settlePublications();
      expect(writeRecord).toHaveBeenCalledTimes(1);
      const [record] = vi.mocked(writeRecord).mock.calls[0]!;
      expect(record.payload).toEqual({
        parentRunId: runId,
        children: [
          {
            kind: 'subagent',
            runId: 'a101',
            agentName: 'review',
            status: RUN_PHASE.RUNNING,
            childRunId: 'stream:native',
          },
          {
            kind: 'subagent',
            runId: 'a102',
            agentName: 'polish',
            status: RUN_PHASE.RUNNING,
            toolName: 'delegate',
            childRunId: 'stream:tool',
          },
          {
            kind: 'subagent',
            runId: 'a103',
            agentName: 'plan',
            status: RUN_PHASE.RUNNING,
            toolName: 'delegate_multi_agents',
            childRunId: 'stream:workflow',
          },
          {
            kind: 'process',
            runId: 'a104',
            agentName: 'bash',
            status: RUN_PHASE.RUNNING,
            toolName: 'bash',
          },
        ],
      });
      detach();
    } finally {
      detach();
    }
  });

  it('writes nothing after detach', async () => {
    const session = createTestSession();
    publishTestRunStart(session, runId, runId);
    publishTestRunStart(session, childRunId, childRunId);
    const { writeRecord, publish, detach } = projectionOver(session);
    await publish(
      draft({
        type: 'updateRunDescription',
        aggregateId: qualifyAggregateId('stream', runId),
        description: 'Proofread the introduction',
      }),
    );
    expect(writeRecord).toHaveBeenCalledWith(
      progressRecord('updateRunDescription', {
        runId,
        description: 'Proofread the introduction',
      }),
    );

    detach();
    await session.settlePublications();
    await publish(
      draft({
        type: 'updateRunDescription',
        aggregateId: qualifyAggregateId('stream', runId),
        description: 'after detach',
      }),
    );
    expect(writeRecord).toHaveBeenCalledTimes(1);
  });

  it('writes one record per published status fact without renderer dedup', async () => {
    const startingPayload: RunStatusProjectionPayload = {
      ...resumingStatusPayload,
      substate: RUN_SUBSTATE.STARTING,
    };
    const session = createTestSession();
    publishTestRunStart(session, runId, runId);
    publishTestRunStart(session, childRunId, childRunId);
    const { writeRecord, publish, detach } = projectionOver(session);
    try {
      await publish(statusDraft(resumingStatusPayload));
      await publish(statusDraft(startingPayload));

      expect(writeRecord).toHaveBeenCalledTimes(2);
      expect(writeRecord).toHaveBeenNthCalledWith(
        1,
        progressRecord('updateStreamStatus', resumingStatusPayload),
      );
      expect(writeRecord).toHaveBeenNthCalledWith(
        2,
        progressRecord('updateStreamStatus', startingPayload),
      );
    } finally {
      detach();
    }
  });
});
