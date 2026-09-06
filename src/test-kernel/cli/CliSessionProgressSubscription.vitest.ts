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
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  type ActiveChildInfo,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@shared/streams/streamStatus';
import { settleSessionEvents } from '@test/agent/progressTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';

const streamId = 'stream:cli-session-projection' as StreamTabId;
const executionId = 'execution:cli-session-projection' as ExecutionId;
const childStreamId = 'stream:cli-child' as StreamTabId;
const childExecutionId = 'execution:cli-child' as ExecutionId;
const storageKey = 'run-a' as ExecutionId;

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
    cause: StreamTransitionCause;
  };

/** A published fact: a run-scoped trace event on `streamId`, or a draft. */
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
    aggregateId: payload.streamId,
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
  parentStreamId: streamId,
  status: 'open' as const,
  lastQuestionPreview: 'Which boundary condition is intended?',
  lastActivityIso: '2026-07-10T12:00:00.000Z',
  turnCount: 1,
};

const PROGRESS_PROJECTION_CASES = {
  setActiveStream: {
    source: draft({
      type: 'run.activate',
      aggregateId: streamId,
      category: AgentCategory.Workflow,
      isRemote: false,
      background: false,
    }),
    payload: {
      streamId,
      agentCategory: AgentCategory.Workflow,
      isRemote: false,
    },
  },
  updateStreamStatus: {
    source: statusDraft({
      streamId,
      status: STREAM_PHASE.RUNNING,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
    }),
    payload: {
      streamId,
      status: STREAM_PHASE.RUNNING,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
    },
  },
  addOutputFiles: {
    source: runEvent({
      type: 'addOutputFiles',
      streamId,
      filesByRound: { 1: [] },
    }),
    payload: { streamId, filesByRound: { 1: [] } },
  },
  updateMissingOutputs: {
    source: runEvent({
      type: 'updateMissingOutputs',
      streamId,
      filesByRound: { 1: ['missing.tex'] },
    }),
    payload: {
      streamId,
      filesByRound: { 1: ['missing.tex'] },
    },
  },
  updateCompileFailures: {
    source: runEvent({
      type: 'updateCompileFailures',
      streamId,
      filesByRound: { 1: [] },
    }),
    payload: { streamId, filesByRound: { 1: [] } },
  },
  setTaskState: {
    source: runEvent({
      type: 'run.config',
      streamId,
      executionId,
      config: projectionConfig,
    }),
    payload: {
      streamId,
      executionId,
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
        streamId,
        storageKey,
        usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
      },
    }),
    payload: {
      streamId,
      storageKey,
      usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
    },
  },
  inquiryThreadUpdated: {
    source: draft({
      type: 'inquiryThreadUpdated',
      aggregateId: inquiryThread.threadId,
      ...inquiryThread,
    }),
    payload: inquiryThread,
  },
  updateTodos: {
    source: runEvent({
      type: 'updateTodos',
      streamId,
      todos: [
        {
          content: 'Check the compactness lemma.',
          status: 'pending',
          activeForm: 'Checking the compactness lemma.',
        },
      ],
    }),
    payload: {
      streamId,
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
      streamId,
      plan: { objective: 'Check the compactness lemma.' },
    }),
    payload: {
      streamId,
      plan: { objective: 'Check the compactness lemma.' },
    },
  },
  updateConversationProgress: {
    source: runEvent({
      type: 'conversation.progress',
      progress: { toolCallCount: 5 },
    }),
    payload: { streamId, progress: { toolCallCount: 5 } },
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
    payload: { streamId, roundStage: { index: 2, total: 4 } },
  },
  updateQueuedFollowUps: {
    source: draft({
      type: 'updateQueuedFollowUps',
      aggregateId: streamId,
      messages: ['queued'],
    }),
    payload: { streamId },
  },
  goalPaused: {
    source: runEvent({ type: 'goalPaused', streamId }),
    payload: { streamId },
  },
  updateStreamDescription: {
    source: draft({
      type: 'updateStreamDescription',
      aggregateId: streamId,
      description: 'Checking the compactness lemma',
    }),
    payload: { streamId, description: 'Checking the compactness lemma' },
  },
  setParentStream: {
    source: draft({
      type: 'setParentStream',
      aggregateId: childStreamId,
      parentStreamId: streamId,
    }),
    payload: { childStreamId, parentStreamId: streamId },
  },
  removeStream: {
    source: draft({ type: 'stream.removed', aggregateId: childStreamId }),
    payload: { streamId: childStreamId },
  },
  goalStateChanged: {
    source: draft({
      type: 'goalStateChanged',
      aggregateId: streamId,
      state: { active: false },
    }),
    payload: { streamId },
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
  parentStreamId: StreamTabId,
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
    if ('run' in source) session.publishRunEvent(streamId, source.run);
    else session.publish([source.draft]);
    await settleSessionEvents();
  };
  return {
    writeRecord,
    publish,
    emitRoster: (parent: StreamTabId, items: readonly ActiveChildInfo[]) =>
      roster?.(parent, items),
    hasRosterListener: () => roster !== undefined,
    detach,
  };
}

const resumingStatusPayload: RunStatusProjectionPayload = {
  streamId,
  status: STREAM_PHASE.RUNNING,
  previousStatus: STREAM_PHASE.WAITING,
  cause: STREAM_TRANSITION_CAUSE.RESUME,
  substate: STREAM_SUBSTATE.RESUMING,
};

const activation: SessionEventDraft = {
  type: 'run.activate',
  aggregateId: streamId,
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
          aggregateId: streamId,
          executionId,
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
          streamId,
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
        aggregateId: streamId,
        executionId,
        identity: { kind: 'agent', agent: 'polish' },
        category: AgentCategory.ToolUse,
        isRemote: false,
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      },
      {
        type: 'run.activate',
        aggregateId: streamId,
        category: AgentCategory.ToolUse,
        isRemote: false,
        background: false,
      },
      {
        type: 'updateStreamDescription',
        aggregateId: streamId,
        description: 'Recorded before the resume',
      },
    ]);
    await settleSessionEvents();

    const { writeRecord, publish, detach } = projectionOver(session);
    try {
      // A resume mints no run.start: the activation is its only new fact.
      await publish(
        draft({
          type: 'run.activate',
          aggregateId: streamId,
          category: AgentCategory.ToolUse,
          isRemote: false,
          background: false,
        }),
      );
      await publish(statusDraft(resumingStatusPayload));

      expect(vi.mocked(writeRecord).mock.calls.map(([r]) => r)).toEqual([
        progressRecord('setActiveStream', {
          streamId,
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
    const { writeRecord, publish, detach } =
      projectionOver(createTestSession());
    try {
      for (const [, projection] of cases) {
        await publish(projection.source);
      }

      expect(writeRecord).toHaveBeenCalledTimes(cases.length);
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

  it('projects updateActiveSubagents rows byte-for-byte onto the frozen public shape', () => {
    // One row per identity kind; `toEqual` (not objectContaining) pins the
    // exact pre-consolidation wire shape: `kind` discriminant, `toolName`
    // encoding, `childStreamId` only on subagent rows, and NO `identity`.
    const items: ActiveChildInfo[] = [
      {
        executionId: 'exec-native' as ExecutionId,
        childStreamId: 'stream:native' as StreamTabId,
        agentName: 'review',
        identity: { kind: 'agent', agent: 'review' },
        status: STREAM_PHASE.RUNNING,
      },
      {
        executionId: 'exec-tool' as ExecutionId,
        childStreamId: 'stream:tool' as StreamTabId,
        agentName: 'polish',
        identity: { kind: 'agent', agent: 'polish', tool: 'delegate' },
        status: STREAM_PHASE.RUNNING,
      },
      {
        executionId: 'exec-workflow' as ExecutionId,
        childStreamId: 'stream:workflow' as StreamTabId,
        agentName: 'plan',
        identity: { kind: 'multiAgentWorkflow', workflowName: 'delegate' },
        status: STREAM_PHASE.RUNNING,
      },
      {
        executionId: 'exec-process' as ExecutionId,
        childStreamId: 'stream:process' as StreamTabId,
        agentName: 'bash',
        identity: { kind: 'process', tool: 'bash' },
        status: STREAM_PHASE.RUNNING,
      },
    ];
    const { writeRecord, emitRoster, hasRosterListener, detach } =
      projectionOver(createTestSession());
    try {
      emitRoster(streamId, items);
      expect(writeRecord).toHaveBeenCalledTimes(1);
      const [record] = vi.mocked(writeRecord).mock.calls[0]!;
      expect(record.payload).toEqual({
        parentStreamId: streamId,
        children: [
          {
            kind: 'subagent',
            executionId: 'exec-native',
            agentName: 'review',
            status: STREAM_PHASE.RUNNING,
            childStreamId: 'stream:native',
          },
          {
            kind: 'subagent',
            executionId: 'exec-tool',
            agentName: 'polish',
            status: STREAM_PHASE.RUNNING,
            toolName: 'delegate',
            childStreamId: 'stream:tool',
          },
          {
            kind: 'subagent',
            executionId: 'exec-workflow',
            agentName: 'plan',
            status: STREAM_PHASE.RUNNING,
            toolName: 'delegate_multi_agents',
            childStreamId: 'stream:workflow',
          },
          {
            kind: 'process',
            executionId: 'exec-process',
            agentName: 'bash',
            status: STREAM_PHASE.RUNNING,
            toolName: 'bash',
          },
        ],
      });
      detach();
      expect(hasRosterListener()).toBe(false);
    } finally {
      detach();
    }
  });

  it('writes nothing after detach', async () => {
    const { writeRecord, publish, detach } =
      projectionOver(createTestSession());
    await publish(
      draft({
        type: 'updateStreamDescription',
        aggregateId: streamId,
        description: 'Proofread the introduction',
      }),
    );
    expect(writeRecord).toHaveBeenCalledWith(
      progressRecord('updateStreamDescription', {
        streamId,
        description: 'Proofread the introduction',
      }),
    );

    detach();
    await settleSessionEvents();
    await publish(
      draft({
        type: 'updateStreamDescription',
        aggregateId: 'stream:after-detach',
        description: 'after detach',
      }),
    );
    expect(writeRecord).toHaveBeenCalledTimes(1);
  });

  it('drains at detach past a transcript row the store no longer holds', async () => {
    const { writeRecord, publish, detach } =
      projectionOver(createTestSession());
    await publish(draft(activation));
    // The row's stream is not in the store, so the tail materializes nothing
    // for its commit: no event says the tail passed the ordinal detach cuts
    // at, only the tail's own coordinate does.
    await publish(
      draft({
        type: 'transcript.entry',
        aggregateId: 'stream:evicted',
        entry: {
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          id: 'row-1',
          seqNo: 1,
          level: 'info',
          timestamp: 1,
          text: 'gone',
        },
      }),
    );

    await detach();

    expect(writeRecord).toHaveBeenCalledTimes(1);
  });

  it('writes one record per published status fact without renderer dedup', async () => {
    const startingPayload: RunStatusProjectionPayload = {
      ...resumingStatusPayload,
      substate: STREAM_SUBSTATE.STARTING,
    };
    const { writeRecord, publish, detach } =
      projectionOver(createTestSession());
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
