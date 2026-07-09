import { describe, expect, it, vi } from 'vitest';

import { logConversationProgress, TraceEmitter } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type { CliProgressSink } from '@cli/runtime/cliProgressEvents';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import { STREAM_TRANSITION_CAUSE } from '@common/constants/streamStatus';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StreamTabId,
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

function hostWithInteractions(
  interactions?: Partial<HostInteractions>,
): CliProgressSink & { interactions: HostInteractions } {
  return {
    emit: vi.fn(),
    interactions: {
      resolve: () => false,
      cancel: () => {},
      ...interactions,
    },
  };
}

function setupTraceProjection() {
  const events = new SessionEventHub();
  const host = hostWithInteractions();
  const trace = new TraceEmitter();
  const detachTrace = trace.subscribe((event) =>
    events.emit({ scope: 'run', streamId, event }),
  );
  const detachProjection = attachCliSessionProgressProjection(events, host);
  return {
    host,
    trace,
    detachAll: () => {
      detachProjection();
      detachTrace();
    },
  };
}

describe('attachCliSessionProgressProjection', () => {
  it('re-emits retained session facts through the headless CLI host rail', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId },
        },
      });

      expect(host.emit).toHaveBeenCalledWith('setActiveStream', { streamId });

      detach();
      events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId: 'stream:after-detach' as StreamTabId },
        },
      });

      expect(host.emit).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
  });

  it('keeps followUpSent session-local', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'followUpSent',
          payload: { streamId },
        },
      });

      expect(host.emit).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('re-emits removeStream through the headless CLI host rail', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'removeStream',
          payload: { streamId },
        },
      });

      expect(host.emit).toHaveBeenCalledWith('removeStream', {
        streamId,
      });
    } finally {
      detach();
    }
  });

  it('re-emits valid retained run facts through the headless CLI host rail', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

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

      expect(host.emit).toHaveBeenCalledWith('updateStreamUsage', {
        streamId,
        storageKey: 'run-a',
        usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
      });
    } finally {
      detach();
    }
  });

  it('projects run config facts to the public setTaskState event', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);
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

      expect(host.emit).toHaveBeenCalledWith('setTaskState', {
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
      });
    } finally {
      detach();
    }
  });

  it('projects status facts to the public stream-status event', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

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

      expect(host.emit).toHaveBeenCalledWith('updateStreamStatus', {
        streamId,
        status: STREAM_PHASE.RUNNING,
        previousStatus: STREAM_PHASE.WAITING,
        cause: STREAM_TRANSITION_CAUSE.RESUME,
        substate: STREAM_SUBSTATE.RESUMING,
      });
    } finally {
      detach();
    }
  });

  it('drops malformed retained run facts instead of forwarding unchecked payloads', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

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

      expect(host.emit).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('derives updateConversationProgress from a conversationProgress domain event', () => {
    const { host, trace, detachAll } = setupTraceProjection();

    try {
      logConversationProgress(trace, {
        toolCallCount: 5,
      });

      expect(host.emit).toHaveBeenCalledWith('updateConversationProgress', {
        streamId,
        progress: { toolCallCount: 5 },
      });
    } finally {
      detachAll();
    }
  });

  it('ignores unrelated domain events and stops forwarding after detach', () => {
    const { host, trace, detachAll } = setupTraceProjection();

    trace.domain({ key: 'webSearch', data: { query: 'irrelevant' } });
    expect(host.emit).not.toHaveBeenCalled();

    detachAll();
    logConversationProgress(trace, { toolCallCount: 0 });
    expect(host.emit).not.toHaveBeenCalled();
  });

  it('drops malformed conversationProgress domain payloads', () => {
    const { host, trace, detachAll } = setupTraceProjection();

    try {
      trace.domain({ key: 'conversationProgress', data: undefined });
      trace.domain({
        key: 'conversationProgress',
        data: { toolCallCount: '1' },
      });
      trace.domain({ key: 'conversationProgress', data: 'not an object' });

      expect(host.emit).not.toHaveBeenCalled();
    } finally {
      detachAll();
    }
  });

  it('projects typed todo and plan run facts', () => {
    const { host, trace, detachAll } = setupTraceProjection();
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

      expect(host.emit).toHaveBeenNthCalledWith(1, 'updateTodos', {
        streamId,
        todos,
      });
      expect(host.emit).toHaveBeenNthCalledWith(2, 'updatePlan', {
        streamId,
        plan,
      });
    } finally {
      detachAll();
    }
  });
});
