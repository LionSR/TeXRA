// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - shared
import type {
  ExecutionId,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';

// Local imports - tools
import { publishCodexStreamUsage, publishCodexTodos } from '@tools/codex';

// Local imports - test
import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:codex-child' as StreamTabId;
const executionId = 'exec:codex-child' as ExecutionId;

const todos: TodoItem[] = [
  {
    content: 'Route Codex progress through the runtime host',
    status: 'pending',
    activeForm: 'Routing Codex progress through the runtime host',
  },
];

const usage: TokenUsageStats = {
  inputTokens: 10,
  outputTokens: 5,
  cost: 0,
};

describe('codex progress events', () => {
  it('publishes todos and usage through the active tool runtime host', async () => {
    const active = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      await withToolFileInteractionContext(
        {
          streamId,
          executionId,
          runtimeHost: active.host,
          tracker: {} as never,
        },
        () => {
          publishCodexTodos(streamId, todos);
          publishCodexStreamUsage(streamId, executionId, usage);
        },
      );
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }

    expect(active.events).toEqual([
      {
        event: 'updateTodos',
        payload: { streamId, todos },
      },
      {
        event: 'updateStreamUsage',
        payload: {
          streamId,
          storageKey: executionId,
          executionId,
          usage,
        },
      },
    ]);
    expect(fallback.events).toEqual([]);
  });

  it('falls back to the default agent runtime host without tool context', () => {
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      publishCodexTodos(streamId, todos);
      publishCodexStreamUsage(streamId, executionId, usage);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }

    expect(fallback.events).toEqual([
      {
        event: 'updateTodos',
        payload: { streamId, todos },
      },
      {
        event: 'updateStreamUsage',
        payload: {
          streamId,
          storageKey: executionId,
          executionId,
          usage,
        },
      },
    ]);
  });
});
