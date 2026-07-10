import { describe, expect, it, vi } from 'vitest';

import { logConversationProgress, TraceEmitter } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  attachCliSessionProgressProjection,
  type CliNdjsonProgressRecordWriter,
} from '@cli/runtime/sessionProgressSubscription';
import {
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@common/constants/streamStatus';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StreamTabId,
  type UpdateStreamStatusPayload,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const streamId = 'stream:cli-session-projection' as StreamTabId;
const executionId = 'execution:cli-session-projection' as ExecutionId;

function workflowConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
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

  it('writes removeStream as a public NDJSON progress record', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'removeStream',
          payload: { streamId },
        },
      });

      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('removeStream', { streamId }),
      );
    } finally {
      detach();
    }
  });

  it('writes valid retained run facts as public NDJSON progress records', () => {
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
            storageKey: 'run-a',
            usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
          },
        },
      });

      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('updateStreamUsage', {
          streamId,
          storageKey: 'run-a',
          usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
        }),
      );
    } finally {
      detach();
    }
  });

  it('projects run config facts to the public setTaskState event', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);
    const config = workflowConfig({
      inputFiles: ['paper.tex', 'appendix.tex'],
      contextFiles: ['notes.md'],
    });

    try {
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'run.config',
          streamId,
          executionId,
          config,
        },
      });

      expect(writeRecord).toHaveBeenCalledWith(
        progressRecord('setTaskState', {
          streamId,
          executionId,
          taskState: {
            agentConfig: config,
            activeFiles: {
              input: true,
              context: true,
              media: false,
              output: false,
            },
          },
        }),
      );
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

  it('emits one NDJSON stream-status record for duplicate session-then-run status facts', () => {
    const events = new SessionEventHub();
    const writeRecord = recordWriter();
    const detach = attachCliSessionProgressProjection(events, writeRecord);

    try {
      emitSessionStatus(events, resumingStatusPayload);
      emitRunStatus(events, resumingStatusPayload);

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
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'domain',
          key: 'runFact.updateTodos',
          data: {
            streamId,
            todos: 'not-an-array',
          },
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

  it('ignores unrelated domain events and stops forwarding after detach', () => {
    const { writeRecord, trace, detachAll } = setupTraceProjection();

    trace.domain({ key: 'webSearch', data: { query: 'irrelevant' } });
    expect(writeRecord).not.toHaveBeenCalled();

    detachAll();
    logConversationProgress(trace, { toolCallCount: 0 });
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('ignores legacy conversationProgress domain payloads', () => {
    const { writeRecord, trace, detachAll } = setupTraceProjection();

    try {
      trace.domain({ key: 'conversationProgress', data: undefined });
      trace.domain({
        key: 'conversationProgress',
        data: { toolCallCount: '1' },
      });
      trace.domain({ key: 'conversationProgress', data: 'not an object' });

      expect(writeRecord).not.toHaveBeenCalled();
    } finally {
      detachAll();
    }
  });

  it('projects typed todo and plan run facts', () => {
    const { writeRecord, trace, detachAll } = setupTraceProjection();
    const todos = [
      {
        content: 'Check the compactness lemma.',
        status: 'pending' as const,
        activeForm: 'Checking the compactness lemma.',
      },
    ];
    const plan = {
      objective: 'Check the compactness lemma and record the obstruction.',
    };

    try {
      trace.emit({ type: 'updateTodos', streamId, todos });
      trace.emit({ type: 'updatePlan', streamId, plan });

      expect(writeRecord).toHaveBeenNthCalledWith(
        1,
        progressRecord('updateTodos', {
          streamId,
          todos,
        }),
      );
      expect(writeRecord).toHaveBeenNthCalledWith(
        2,
        progressRecord('updatePlan', {
          streamId,
          plan,
        }),
      );
    } finally {
      detachAll();
    }
  });
});
