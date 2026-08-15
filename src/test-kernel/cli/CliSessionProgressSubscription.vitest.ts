import { describe, expect, it, vi } from 'vitest';

import {
  logConversationProgress,
  TraceEmitter,
  type AgentEvent,
} from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  SessionEventHub,
  type SessionEvent,
  type SessionFact,
} from '@agent/runtime/SessionEventHub';
import type {
  CliNdjsonProgressEvent,
  CliNdjsonProgressEventPayloads,
} from '@cli/runtime/cliNdjsonProgressEvents';
import {
  attachCliSessionProgressProjection,
  type CliNdjsonProgressRecordWriter,
} from '@cli/runtime/sessionProgressSubscription';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
} from '@shared/schemas';
import type {
  ExecutionId,
  StorageKey,
  StreamTabId,
  UpdateStreamStatusPayload,
} from '@shared/schemas';
import {
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@shared/streams/streamStatus';
import type { PayloadSessionFact } from '@test/agent/progressTestUtils';

const streamId = 'stream:cli-session-projection' as StreamTabId;
const executionId = 'execution:cli-session-projection' as ExecutionId;
const childStreamId = 'stream:cli-child' as StreamTabId;
const childExecutionId = 'execution:cli-child' as ExecutionId;
const storageKey = 'run-a' as StorageKey;

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

function sessionFact<K extends PayloadSessionFact['type']>(
  type: K,
  payload: Extract<PayloadSessionFact, { type: K }>['payload'],
): SessionEvent {
  return {
    scope: 'session',
    event: { type, payload } as Extract<SessionFact, { type: K }>,
  };
}

function statusFact(payload: RunStatusProjectionPayload): SessionEvent {
  return {
    scope: 'session',
    event: {
      type: 'status',
      streamId: payload.streamId,
      phase: payload.status,
      cause: payload.cause,
      ...(payload.previousStatus
        ? { previousPhase: payload.previousStatus }
        : {}),
      ...(payload.substate ? { substate: payload.substate } : {}),
    },
  };
}

function runEvent(event: AgentEvent): SessionEvent {
  return { scope: 'run', streamId, event };
}

type ProgressProjectionCases = {
  [K in CliNdjsonProgressEvent]: {
    readonly source: SessionEvent;
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
const child = {
  executionId: childExecutionId,
  childStreamId,
  agentName: 'review',
  identity: { kind: 'agent' as const, agent: 'review' },
  status: STREAM_PHASE.RUNNING,
};
const PROGRESS_PROJECTION_CASES = {
  setActiveStream: {
    source: sessionFact('setActiveStream', { streamId }),
    payload: { streamId },
  },
  updateStreamStatus: {
    source: statusFact({
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
      executionId,
      filesByRound: { 1: [] },
    }),
    payload: { streamId, executionId, filesByRound: { 1: [] } },
  },
  updateMissingOutputs: {
    source: runEvent({
      type: 'updateMissingOutputs',
      streamId,
      executionId,
      filesByRound: { 1: ['missing.tex'] },
    }),
    payload: {
      streamId,
      executionId,
      filesByRound: { 1: ['missing.tex'] },
    },
  },
  updateCompileFailures: {
    source: runEvent({
      type: 'updateCompileFailures',
      streamId,
      executionId,
      filesByRound: { 1: [] },
    }),
    payload: { streamId, executionId, filesByRound: { 1: [] } },
  },
  clearMissingOutputs: {
    source: sessionFact('clearMissingOutputs', { streamId }),
    payload: { streamId },
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
    source: sessionFact('inquiryThreadUpdated', inquiryThread),
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
    source: sessionFact('updateQueuedFollowUps', { streamId }),
    payload: { streamId },
  },
  goalPaused: {
    source: runEvent({ type: 'goalPaused', streamId }),
    payload: { streamId },
  },
  updateActiveSubagents: {
    source: runEvent({
      type: 'child.activity',
      parentStreamId: streamId,
      items: [child],
    }),
    // The frozen public row shape: `kind` discriminant, no `identity`.
    payload: {
      parentStreamId: streamId,
      children: [
        {
          kind: 'subagent',
          executionId: childExecutionId,
          agentName: 'review',
          status: STREAM_PHASE.RUNNING,
          childStreamId,
        },
      ],
    },
  },
  updateStreamDescription: {
    source: sessionFact('updateStreamDescription', {
      streamId,
      description: 'Checking the compactness lemma',
    }),
    payload: { streamId, description: 'Checking the compactness lemma' },
  },
  setParentStream: {
    source: sessionFact('setParentStream', {
      childStreamId,
      parentStreamId: streamId,
    }),
    payload: { childStreamId, parentStreamId: streamId },
  },
  removeStream: {
    source: sessionFact('removeStream', { streamId: childStreamId }),
    payload: { streamId: childStreamId },
  },
  goalStateChanged: {
    source: sessionFact('goalStateChanged', { streamId }),
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

function withProjection(
  run: (context: {
    events: SessionEventHub;
    writeRecord: CliNdjsonProgressRecordWriter;
    detach: () => void;
  }) => void,
): void {
  const events = new SessionEventHub();
  const writeRecord = recordWriter();
  const detach = attachCliSessionProgressProjection(events, writeRecord);
  try {
    run({ events, writeRecord, detach });
  } finally {
    detach();
  }
}

function setupTraceProjection() {
  const events = new SessionEventHub();
  const writeRecord = recordWriter();
  const trace = new TraceEmitter();
  const detachTrace = trace.subscribe((event) =>
    events.emit({ scope: 'run', streamId, event }),
  );
  const detachProjection = attachCliSessionProgressProjection(
    events,
    writeRecord,
  );
  return {
    writeRecord,
    trace,
    detachAll: () => {
      detachProjection();
      detachTrace();
    },
  };
}

type RunStatusProjectionPayload = UpdateStreamStatusPayload & {
  cause: StreamTransitionCause;
};

const resumingStatusPayload: RunStatusProjectionPayload = {
  streamId,
  status: STREAM_PHASE.RUNNING,
  previousStatus: STREAM_PHASE.WAITING,
  cause: STREAM_TRANSITION_CAUSE.RESUME,
  substate: STREAM_SUBSTATE.RESUMING,
};

describe('attachCliSessionProgressProjection', () => {
  it('projects every public NDJSON progress event with its typed payload', () => {
    const cases = Object.entries(PROGRESS_PROJECTION_CASES);

    withProjection(({ events, writeRecord }) => {
      for (const [, projection] of cases) {
        events.emit(projection.source);
      }

      expect(writeRecord).toHaveBeenCalledTimes(cases.length);
      for (const [index, [event, projection]] of cases.entries()) {
        expect(writeRecord).toHaveBeenNthCalledWith(
          index + 1,
          progressRecord(event, projection.payload),
        );
      }
    });
  });

  it('projects updateActiveSubagents rows byte-for-byte onto the frozen public shape', () => {
    // One row per identity kind; `toEqual` (not objectContaining) pins the
    // exact pre-consolidation wire shape: `kind` discriminant, `toolName`
    // encoding, `childStreamId` only on subagent rows, and NO `identity`.
    const items = [
      {
        executionId: 'exec-native' as ExecutionId,
        childStreamId: 'stream:native-child',
        identity: { kind: 'agent' as const, agent: 'review' },
        agentName: 'review',
        status: STREAM_PHASE.RUNNING,
        startedAt: 1754280000000,
        elapsed: '1m 2s',
      },
      {
        executionId: 'exec-codex' as ExecutionId,
        childStreamId: 'stream:codex-child',
        identity: { kind: 'agent' as const, agent: 'coder', tool: 'codex' },
        agentName: 'coder',
        status: STREAM_PHASE.RUNNING,
      },
      {
        executionId: 'exec-bash' as ExecutionId,
        childStreamId: 'stream:bash-child',
        identity: { kind: 'process' as const, tool: 'bash' },
        agentName: 'bash',
        finishedAt: 1754280060000,
      },
      {
        executionId: 'exec-workflow' as ExecutionId,
        childStreamId: 'stream:workflow-child',
        identity: {
          kind: 'multiAgentWorkflow' as const,
          workflowName: 'engineer',
        },
        agentName: 'engineer',
        workflowPhase: 'implement',
      },
    ];

    withProjection(({ events, writeRecord }) => {
      events.emit(
        runEvent({
          type: 'child.activity',
          parentStreamId: streamId,
          items,
        }),
      );

      const written = vi
        .mocked(writeRecord)
        .mock.calls.at(0)?.[0] as unknown as {
        payload: { children: unknown[] };
      };
      expect(written.payload.children).toStrictEqual([
        {
          kind: 'subagent',
          executionId: 'exec-native',
          agentName: 'review',
          status: STREAM_PHASE.RUNNING,
          startedAt: 1754280000000,
          elapsed: '1m 2s',
          childStreamId: 'stream:native-child',
        },
        {
          kind: 'subagent',
          executionId: 'exec-codex',
          agentName: 'coder',
          status: STREAM_PHASE.RUNNING,
          toolName: 'codex',
          childStreamId: 'stream:codex-child',
        },
        {
          kind: 'process',
          executionId: 'exec-bash',
          agentName: 'bash',
          finishedAt: 1754280060000,
          toolName: 'bash',
        },
        {
          kind: 'subagent',
          executionId: 'exec-workflow',
          agentName: 'engineer',
          workflowPhase: 'implement',
          toolName: 'delegate_multi_agents',
          childStreamId: 'stream:workflow-child',
        },
      ]);
    });
  });

  it('writes retained session facts as public NDJSON progress records', () => {
    withProjection(({ events, writeRecord, detach }) => {
      events.emit(sessionFact('setActiveStream', { streamId }));

      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('setActiveStream', { streamId }),
      );

      detach();
      events.emit(
        sessionFact('setActiveStream', {
          streamId: 'stream:after-detach' as StreamTabId,
        }),
      );

      expect(writeRecord).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps followUpSent session-local', () => {
    withProjection(({ events, writeRecord }) => {
      events.emit(sessionFact('followUpSent', { streamId }));

      expect(writeRecord).not.toHaveBeenCalled();
    });
  });

  it('projects status facts to the public stream-status event', () => {
    withProjection(({ events, writeRecord }) => {
      events.emit(statusFact(resumingStatusPayload));

      expect(writeRecord).toHaveBeenCalledTimes(1);
      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('updateStreamStatus', resumingStatusPayload),
      );
    });
  });

  // A run-scope status event is no longer representable: `status` left the
  // `AgentEvent` union, so the session-fact rail is the only status channel
  // by construction — the old "ignore stray run-scope status" guard is now
  // enforced by the compiler.

  it('writes one record per published status fact without renderer dedup', () => {
    const startingPayload: RunStatusProjectionPayload = {
      ...resumingStatusPayload,
      substate: STREAM_SUBSTATE.STARTING,
    };

    withProjection(({ events, writeRecord }) => {
      events.emit(statusFact(resumingStatusPayload));
      events.emit(statusFact(startingPayload));

      expect(writeRecord).toHaveBeenCalledTimes(2);
      expect(writeRecord).toHaveBeenNthCalledWith(
        1,
        progressRecord('updateStreamStatus', resumingStatusPayload),
      );
      expect(writeRecord).toHaveBeenNthCalledWith(
        2,
        progressRecord('updateStreamStatus', startingPayload),
      );
    });
  });

  it('refuses an event outside the run-fact vocabulary instead of dropping it', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    let runSubscriber: ((event: SessionEvent) => void) | undefined;
    vi.spyOn(events, 'subscribe').mockImplementation(
      (subscriber, filter = {}) => {
        if (filter.scope === 'run') runSubscriber = subscriber;
        return () => {};
      },
    );
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      if (!runSubscriber) throw new Error('Run subscriber was not attached');
      const project = (): void =>
        runSubscriber?.({
          scope: 'run',
          streamId,
          event: {
            type: 'log',
            level: 'info',
            message: 'not a progress fact',
          },
        });

      // The subscription filter admits only RUN_FACT_EVENT_TYPES, so this can
      // only happen if the filter and the projection drift apart. SessionEventHub
      // contains a throwing subscriber, so the failure is loud, not fatal.
      expect(project).toThrow('Unhandled CLI NDJSON run fact');
      expect(writeRecord).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('derives updateConversationProgress from a typed conversation progress event', () => {
    const { writeRecord, trace, detachAll } = setupTraceProjection();

    try {
      logConversationProgress(trace, {
        toolCallCount: 5,
      });

      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('updateConversationProgress', {
          streamId,
          progress: { toolCallCount: 5 },
        }),
      );
    } finally {
      detachAll();
    }
  });

  it('ignores legacy conversationProgress domain events', () => {
    const { writeRecord, trace, detachAll } = setupTraceProjection();

    try {
      trace.domain({ key: 'conversationProgress', data: undefined });

      expect(writeRecord).not.toHaveBeenCalled();
    } finally {
      detachAll();
    }
  });
});
