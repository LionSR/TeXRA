import { describe, expect, it, vi } from 'vitest';

import {
  logConversationProgress,
  TraceEmitter,
  type AgentEvent,
} from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
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
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
  type UpdateStreamStatusPayload,
} from '@shared/schemas';
import {
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@shared/streams/streamStatus';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const streamId = 'stream:cli-session-projection' as StreamTabId;
const executionId = 'execution:cli-session-projection' as ExecutionId;
const childStreamId = 'stream:cli-child' as StreamTabId;
const childExecutionId = 'execution:cli-child' as ExecutionId;
const processExecutionId = 'execution:cli-process' as ExecutionId;
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

function sessionFact<K extends SessionFact['type']>(
  type: K,
  payload: Extract<SessionFact, { type: K }>['payload'],
): SessionEvent {
  return {
    scope: 'session',
    event: { type, payload } as Extract<SessionFact, { type: K }>,
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
  kind: 'subagent' as const,
  executionId: childExecutionId,
  childStreamId,
  agentName: 'review',
  status: 'running',
};
const process = {
  kind: 'process' as const,
  executionId: processExecutionId,
  agentName: 'latexmk',
  status: 'running',
};

const PROGRESS_PROJECTION_CASES = {
  setActiveStream: {
    source: sessionFact('setActiveStream', { streamId }),
    payload: { streamId },
  },
  updateStreamStatus: {
    source: sessionFact('updateStreamStatus', {
      streamId,
      status: STREAM_PHASE.RUNNING,
    }),
    payload: { streamId, status: STREAM_PHASE.RUNNING },
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
      stats: {},
      data: {
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
      kind: 'subagents',
      parentStreamId: streamId,
      items: [child],
    }),
    payload: { parentStreamId: streamId, children: [child] },
  },
  updateActiveProcesses: {
    source: runEvent({
      type: 'child.activity',
      kind: 'processes',
      parentStreamId: streamId,
      items: [process],
    }),
    payload: { parentStreamId: streamId, processes: [process] },
  },
  updateProcessOutput: {
    source: runEvent({
      type: 'process.output',
      parentStreamId: streamId,
      executionId: processExecutionId,
      stdout: 'compiled paper.pdf\n',
      stderr: '',
    }),
    payload: {
      parentStreamId: streamId,
      executionId: processExecutionId,
      stdout: 'compiled paper.pdf\n',
      stderr: '',
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

function emitRunStatus(
  events: SessionEventHub,
  payload: RunStatusProjectionPayload,
): void {
  events.emit({
    scope: 'run',
    streamId,
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
  });
}

function emitSessionStatus(
  events: SessionEventHub,
  payload: UpdateStreamStatusPayload,
): void {
  events.emit({
    scope: 'session',
    event: {
      type: 'updateStreamStatus',
      payload,
    },
  });
}

describe('attachCliSessionProgressProjection', () => {
  it('projects every public NDJSON progress event with its typed payload', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);
    const cases = Object.entries(PROGRESS_PROJECTION_CASES);

    try {
      for (const projection of Object.values(PROGRESS_PROJECTION_CASES)) {
        events.emit(projection.source);
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

  it('writes retained session facts as public NDJSON progress records', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId },
        },
      });

      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('setActiveStream', { streamId }),
      );

      detach();
      events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId: 'stream:after-detach' as StreamTabId },
        },
      });

      expect(writeRecord).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
  });

  it('keeps followUpSent session-local', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'followUpSent',
          payload: { streamId },
        },
      });

      expect(writeRecord).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('projects status facts to the public stream-status event', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'status',
          streamId,
          phase: STREAM_PHASE.RUNNING,
          previousPhase: STREAM_PHASE.WAITING,
          cause: STREAM_TRANSITION_CAUSE.RESUME,
          substate: STREAM_SUBSTATE.RESUMING,
        },
      });

      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('updateStreamStatus', {
          streamId,
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.WAITING,
          cause: STREAM_TRANSITION_CAUSE.RESUME,
          substate: STREAM_SUBSTATE.RESUMING,
        }),
      );
    } finally {
      detach();
    }
  });

  it('emits one NDJSON stream-status record for duplicate run-then-session status facts', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      emitRunStatus(events, resumingStatusPayload);
      emitSessionStatus(events, resumingStatusPayload);

      expect(writeRecord).toHaveBeenCalledTimes(1);
      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('updateStreamStatus', resumingStatusPayload),
      );
    } finally {
      detach();
    }
  });

  it('keeps same-phase stream-status records when substate changes', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);
    const startingPayload: RunStatusProjectionPayload = {
      ...resumingStatusPayload,
      substate: STREAM_SUBSTATE.STARTING,
    };

    try {
      emitRunStatus(events, resumingStatusPayload);
      emitSessionStatus(events, startingPayload);

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

  it('forgets the last status when a stream is removed', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      emitSessionStatus(events, resumingStatusPayload);
      emitSessionStatus(events, resumingStatusPayload);
      events.emit({
        scope: 'session',
        event: { type: 'removeStream', payload: { streamId } },
      });
      emitSessionStatus(events, resumingStatusPayload);

      expect(writeRecord).toHaveBeenCalledTimes(3);
      expect(writeRecord).toHaveBeenNthCalledWith(
        1,
        progressRecord('updateStreamStatus', resumingStatusPayload),
      );
      expect(writeRecord).toHaveBeenNthCalledWith(
        2,
        progressRecord('removeStream', { streamId }),
      );
      expect(writeRecord).toHaveBeenNthCalledWith(
        3,
        progressRecord('updateStreamStatus', resumingStatusPayload),
      );
    } finally {
      detach();
    }
  });

  it('drops malformed retained run facts instead of forwarding unchecked payloads', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'usage',
          stats: {},
          data: {
            streamId,
            usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
          },
        },
      });
      expect(writeRecord).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('does not project run events outside the shared fact vocabulary', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'log',
          level: 'info',
          message: 'not a progress fact',
        },
      });

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
