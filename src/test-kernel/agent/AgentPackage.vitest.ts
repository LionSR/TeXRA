// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - types
import type { Platform } from '@platform/platform';

const mocks = vi.hoisted(() => ({
  activePlatform: null as object | null,
  detachEvents: vi.fn(),
  detachInteractions: vi.fn(),
  disposeSession: vi.fn(),
  eventListener: undefined as
    | ((event: { readonly scope: string; readonly event: unknown }) => void)
    | undefined,
  initNodeAgentRuntime: vi.fn(),
  initPlatform: vi.fn(),
  loadAgents: vi.fn(),
  runValidatedAgent: vi.fn(),
  subscribe: vi.fn(
    (
      listener: (event: {
        readonly scope: string;
        readonly event: unknown;
      }) => void,
    ) => {
      mocks.eventListener = listener;
      return mocks.detachEvents;
    },
  ),
  useHostInteractions: vi.fn(() => mocks.detachInteractions),
}));

vi.mock('@agent/core/definition/AgentConfig', () => ({
  AgentConfigSchema: { parse: (value: unknown) => value },
}));

vi.mock('@agent/index/agentRegistry', () => ({
  loadAgents: mocks.loadAgents,
  resolveAgent: () => ({
    entry: { category: 'toolUse', source: 'custom' },
    resolvedName: 'assistant',
  }),
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  SessionHandle: class {
    readonly events = { subscribe: mocks.subscribe };

    useHostInteractions = mocks.useHostInteractions;
    dispose = mocks.disposeSession;
  },
}));

vi.mock('@agent/runtime/runAgent', () => ({
  runAgent: mocks.runValidatedAgent,
}));

vi.mock('@platform/defaults/nodeHost', () => ({
  initNodeAgentRuntime: mocks.initNodeAgentRuntime,
}));

vi.mock('@platform/platform', () => ({
  initPlatform: mocks.initPlatform,
  tryPlatform: () => mocks.activePlatform,
}));

vi.mock('@transcript/StreamLogStore', () => ({
  StreamLogStore: { ephemeral: () => ({}) },
}));

// Local imports - package API under test
import { runAgent } from '../../../packages/agent/src/index';

const PLATFORM = { lifecycle: {} } as unknown as Platform;
const RESULT = { outcome: 'COMPLETED' } as never;
const EVENT = { type: 'run.start' } as never;
const INPUT = {
  agent: 'assistant',
  instruction: 'Test instruction',
  interactions: { cancel: vi.fn() },
  platform: PLATFORM,
};

describe('agent package run lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activePlatform = null;
    mocks.eventListener = undefined;
    mocks.loadAgents.mockResolvedValue(undefined);
    mocks.runValidatedAgent.mockImplementation(
      async (
        _input: unknown,
        options: {
          readonly onStreamResolved?: (streamId: string) => void;
        },
      ) => {
        options.onStreamResolved?.('stream:package');
        return RESULT;
      },
    );
  });

  it('initializes standard runtime features for a custom platform', async () => {
    await runAgent(INPUT).result;

    expect(mocks.initPlatform).toHaveBeenCalledWith(PLATFORM);
    expect(mocks.initNodeAgentRuntime).toHaveBeenCalledWith(PLATFORM.lifecycle);
  });

  it('does not subscribe when the caller only awaits the result', async () => {
    await runAgent(INPUT).result;

    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('detaches the event source when iteration ends early', async () => {
    let finishRun: ((result: typeof RESULT) => void) | undefined;
    mocks.runValidatedAgent.mockImplementationOnce(
      async (
        _input: unknown,
        options: {
          readonly onStreamResolved?: (streamId: string) => void;
        },
      ) => {
        options.onStreamResolved?.('stream:package');
        return await new Promise<typeof RESULT>((resolve) => {
          finishRun = resolve;
        });
      },
    );

    const run = runAgent(INPUT);
    const iterator = run[Symbol.asyncIterator]();
    const nextEvent = iterator.next();
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    mocks.eventListener?.({ scope: 'run', event: EVENT });

    await expect(nextEvent).resolves.toEqual({ done: false, value: EVENT });
    await iterator.return?.();
    expect(mocks.detachEvents).toHaveBeenCalledOnce();

    finishRun?.(RESULT);
    await expect(run.result).resolves.toBe(RESULT);
  });
});
