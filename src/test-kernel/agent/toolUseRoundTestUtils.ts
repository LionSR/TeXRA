// Third-party imports
import { vi } from 'vitest';

// Local imports
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { createRunTrace, StreamLogStore } from '@transcript';

// Local file imports
import { testRunScope } from './progressTestUtils';

/**
 * Fields identical across every `ToolUseRoundServices` fixture. `modelCell`,
 * `session`, `setting`, and `toolRegistry` vary per scenario, so those stay
 * inline at each call site.
 */
export function baseRoundServices(
  traceLabel: string,
  streamId = 'test-stream',
  signal = new AbortController().signal,
) {
  return {
    runScope: testRunScope(streamId, { signal }),
    config: { agent: 'test-agent', model: 'test-model' },
    fileService: {
      createLocation: (filePath: string) => ({ absolutePath: filePath }),
    },
    logger: createRunTrace(traceLabel, StreamLogStore.ephemeral('test')).trace,
    onRoundFinalized: () => {},
    prompt: { systemPrompt: '', userPrefix: '', userRequest: '' },
    run: AgentRunStateSnapshotSchema.parse({}),
    userVarChannels: { input: {}, transient: {} },
    workspace: AgentWorkspaceState.create(),
  };
}

/**
 * The model-handler surface a full round drives: response extraction,
 * server-tool data, routing, streaming. Scenarios override only the members
 * whose behavior they exercise.
 */
export function roundModelHandler(overrides: Record<string, unknown>) {
  return {
    addMediaToUserMessage: vi.fn(async () => []),
    capabilities: { supportsVision: true },
    config: { provider: 'openai', fullName: 'test-model' },
    createAssistantMessageFromResponse: vi.fn(
      (_response: unknown, text: string) =>
        ({ type: 'message', role: 'assistant', content: text }) as never,
    ),
    extractAssistantContent: () => [],
    extractServerToolData: () => ({
      contentBlocks: [],
      webFetchResults: [],
      webSearchResults: [],
    }),
    extractToolUse: () => [],
    getClient: vi.fn(async () => ({})),
    getCredentialRouteForClient: () => undefined,
    getWireRouteKey: () => 'openai:test-route',
    getModelRetryRouteKey: () => 'openai:test-route:model',
    getStreamingConfig: () => false,
    isEndTurnStop: (stopReason: string) => stopReason === 'stop',
    processThinkingBlock: () => null,
    setOutputStreaming: vi.fn(),
    ...overrides,
  };
}
