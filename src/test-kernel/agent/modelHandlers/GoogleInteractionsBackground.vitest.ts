// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports - agent and config
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { noopTrace } from '@agent/trace/noopTrace';
import * as configModule from '@utils/config/configUtils';
import * as providerConfigModule from '@utils/config/providerConfig';

// Local imports - test fixtures
import { buildTestModelConfig } from './testFixtures';

// Type imports
import type { Interactions } from '@google/genai';

type Step = Interactions.Step;

/**
 * BACKGROUND-mode unit tests (B1–B10) for ModelHandlerGoogleInteractions.
 *
 * The poll loop is driven with vi.useFakeTimers(): the `delay` package honors
 * fake timers, so advancing the clock by BACKGROUND_POLL_INTERVAL_MS resolves
 * each poll wait. A non-streaming capturing client records create() params and
 * serves a scripted sequence of get() results.
 *
 * Real-key SMOKE-TEST items (cannot be unit-tested offline):
 * - S-BG1: the initial status of a background:true create (expected in_progress).
 * - S-BG2: background:true accepted with store:true / rejected with store:false.
 * - S-BG3: get(id) on a completed background interaction returns full steps+usage.
 * - S-BG4: cancel(id) on an in_progress interaction transitions it to cancelled.
 * - S-BG5: real poll cadence / latency to tune BACKGROUND_POLL_INTERVAL_MS (5s).
 */

const POLL_INTERVAL_MS = 5000;
const MAX_DURATION_MS = 3 * 60 * 60 * 1000;

interface Interaction {
  id: string;
  status: string;
  steps?: Step[];
}

/** One recorded `interactions.create` request. */
interface CreateCall {
  store: boolean | undefined;
  background: boolean | undefined;
  stream: boolean | undefined;
  previousId: string | undefined;
  input: Step[];
}

interface CapturedCalls {
  create: CreateCall[];
  get: string[];
  cancel: string[];
}

/**
 * Non-streaming capturing client. `create` records the request and returns
 * `submit()`. `get` serves successive entries of `getSequence` (clamped to the
 * last). `cancel` records the id and invokes `onCancel`.
 */
function bgClient(opts: {
  submit: () => Interaction;
  getSequence: Interaction[];
  onCancel?: (id: string) => void;
  generateContent?: () => Promise<unknown>;
}): { client: unknown; calls: CapturedCalls } {
  let getIdx = 0;
  const calls: CapturedCalls = { create: [], get: [], cancel: [] };
  const client = {
    interactions: {
      create: async (params: {
        store?: boolean;
        background?: boolean;
        stream?: boolean;
        previous_interaction_id?: string;
        input: Step[];
      }) => {
        calls.create.push({
          store: params.store,
          background: params.background,
          stream: params.stream,
          previousId: params.previous_interaction_id,
          input: [...params.input],
        });
        return opts.submit();
      },
      get: async (id: string) => {
        calls.get.push(id);
        const next =
          opts.getSequence[Math.min(getIdx, opts.getSequence.length - 1)];
        getIdx += 1;
        return next;
      },
      cancel: async (id: string) => {
        calls.cancel.push(id);
        opts.onCancel?.(id);
        return {};
      },
    },
    models: opts.generateContent
      ? { generateContent: opts.generateContent }
      : {},
  };
  return { client, calls };
}

/** Workflow-mode handler so isBackgroundModeEligible() is true. */
function createHandler(
  category: AgentCategory = AgentCategory.Workflow,
): ModelHandlerGoogleInteractions {
  const handler = new ModelHandlerGoogleInteractions(
    buildTestModelConfig({
      name: 'test-google-interactions',
      label: 'Test Google Interactions',
      fullName: 'gemini-3-pro-test',
      shortName: 'gemini-3-pro-test',
      provider: ModelProvider.GOOGLE,
      contextWindow: 4096,
      capabilities: {
        supportsReasoning: true,
        supportsTokenCounting: false,
      },
    }),
  );
  handler.setLogger({ ...noopTrace });
  handler.setAgentCategory(category);
  return handler;
}

function userStep(text: string): Step {
  return { type: 'user_input', content: [{ type: 'text', text }] };
}

function modelOutput(text: string): Step {
  return { type: 'model_output', content: [{ type: 'text', text }] };
}

function completedInteraction(id: string, text = 'ok'): Interaction {
  return { id, status: 'completed', steps: [modelOutput(text)] };
}

const originalGetConfig = configModule.getConfig;

/**
 * Mock both gating settings. By default both are ON (server-state + background)
 * so the background path activates for a workflow handler. Streaming is forced
 * OFF so the NON-background fallback (B5/B6) takes the non-streaming `create`
 * path against the plain (non-iterable) fake client.
 */
function mockConfig(
  opts: {
    serverState?: boolean;
    background?: boolean;
  } = {},
): void {
  const serverState = opts.serverState ?? true;
  const background = opts.background ?? true;
  vi.spyOn(configModule, 'getConfig').mockImplementation(
    <T>(key: string, defaultValue?: T): T => {
      if (key === 'texra.model.useGoogleInteractionsServerState') {
        return serverState as T;
      }
      if (key === 'texra.model.useBackgroundResponses') {
        return background as T;
      }
      return originalGetConfig(key, defaultValue);
    },
  );
  vi.spyOn(providerConfigModule, 'getProviderStreaming').mockReturnValue(false);
  vi.spyOn(providerConfigModule, 'getGlobalStreaming').mockReturnValue(false);
}

/** Run a createResponse while draining the fake-timer poll waits. */
async function runWithPolls<T>(promise: Promise<T>, ticks: number): Promise<T> {
  for (let i = 0; i < ticks; i += 1) {
    // Let microtasks settle, then advance past one poll interval.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  }
  return promise;
}

describe('ModelHandlerGoogleInteractions background mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('B1: background submit sets background:true + store:true + stream:false', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [completedInteraction('int_1')],
    });

    const promise = handler.createResponse({
      client: client as never,
      messages: [userStep('a')],
      temperature: 0,
    });
    const result = await runWithPolls(promise, 2);

    expect(calls.create[0].background).toBe(true);
    expect(calls.create[0].store).toBe(true);
    expect(calls.create[0].stream).toBe(false);
    expect(result.response.status).toBe('completed');
  });

  it('B2: polls get() until completed', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [
        { id: 'int_1', status: 'in_progress' },
        { id: 'int_1', status: 'in_progress' },
        completedInteraction('int_1'),
      ],
    });

    const promise = handler.createResponse({
      client: client as never,
      messages: [userStep('a')],
      temperature: 0,
    });
    const result = await runWithPolls(promise, 4);

    expect(calls.get.length).toBeGreaterThanOrEqual(3);
    expect(calls.get.every((id) => id === 'int_1')).toBe(true);
    expect(result.response.status).toBe('completed');
  });

  it('B3: captures the chain id from the polled completion (not the submit)', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_submit', status: 'in_progress' }),
      getSequence: [completedInteraction('int_done')],
    });

    const messages: Step[] = [userStep('a')];
    await runWithPolls(
      handler.createResponse({
        client: client as never,
        messages,
        temperature: 0,
      }),
      2,
    );

    // Second turn: chained submit is immediately completed (no polling needed).
    const { client: client2, calls: calls2 } = bgClient({
      submit: () => completedInteraction('int_done2'),
      getSequence: [completedInteraction('int_done2')],
    });
    messages.push(userStep('b'));
    await runWithPolls(
      handler.createResponse({
        client: client2 as never,
        messages,
        temperature: 0,
      }),
      1,
    );

    expect(calls.create[0].previousId).toBeUndefined();
    expect(calls2.create[0].previousId).toBe('int_done'); // NOT 'int_submit'
    expect(calls2.create[0].input).toHaveLength(1);
  });

  it('B4: cancel on abort calls interactions.cancel and leaves no leak', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const controller = new AbortController();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [{ id: 'int_1', status: 'in_progress' }],
    });

    const promise = handler.createResponse({
      client: client as never,
      messages: [userStep('a')],
      temperature: 0,
      signal: controller.signal,
    });
    const rejection = expect(promise).rejects.toThrow();

    // Allow the submit + first poll wait to begin, then abort.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await rejection;

    expect(calls.cancel).toContain('int_1');
    // The pending-id (cancel target) is reset on abort so a later abort can't
    // cancel the wrong interaction.
    expect(
      (handler as unknown as { pendingBackgroundInteractionId: string | null })
        .pendingBackgroundInteractionId,
    ).toBeNull();

    // No leak: a fresh serial call on the same handler succeeds.
    const { client: client2 } = bgClient({
      submit: () => completedInteraction('int_2'),
      getSequence: [completedInteraction('int_2')],
    });
    await expect(
      runWithPolls(
        handler.createResponse({
          client: client2 as never,
          messages: [userStep('b')],
          temperature: 0,
        }),
        1,
      ),
    ).resolves.toBeDefined();
  });

  it('B5: background + stateless takes the non-background path', async () => {
    mockConfig({ serverState: false, background: true });
    vi.useFakeTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => completedInteraction('int_1'),
      getSequence: [completedInteraction('int_1')],
    });

    await runWithPolls(
      handler.createResponse({
        client: client as never,
        messages: [userStep('a')],
        temperature: 0,
      }),
      1,
    );

    expect(calls.create[0].background).toBeFalsy();
    expect(calls.create[0].store).toBe(false);
    expect(calls.get).toHaveLength(0);
  });

  it('B6: toggle off => no background', async () => {
    mockConfig({ serverState: true, background: false });
    vi.useFakeTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => completedInteraction('int_1'),
      getSequence: [completedInteraction('int_1')],
    });

    await runWithPolls(
      handler.createResponse({
        client: client as never,
        messages: [userStep('a')],
        temperature: 0,
      }),
      1,
    );

    expect(calls.create[0].background).toBeFalsy();
    expect(calls.create[0].store).toBe(true); // still stateful, just not background
    expect(calls.get).toHaveLength(0);
  });

  it('B7: terminal non-completed (failed) throws and does not chain', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const { client } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [{ id: 'int_1', status: 'failed' }],
    });

    const promise = handler.createResponse({
      client: client as never,
      messages: [userStep('a')],
      temperature: 0,
    });
    const rejection = expect(promise).rejects.toThrow(/status "failed"/);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await rejection;

    // Next turn full-resends (chain never established).
    const { client: client2, calls: calls2 } = bgClient({
      submit: () => completedInteraction('int_2'),
      getSequence: [completedInteraction('int_2')],
    });
    await runWithPolls(
      handler.createResponse({
        client: client2 as never,
        messages: [userStep('a'), userStep('b')],
        temperature: 0,
      }),
      1,
    );
    expect(calls2.create[0].previousId).toBeUndefined();
    expect(calls2.create[0].input).toHaveLength(2);
  });

  it('B8: requires_action is a serviceable terminal — returned (not thrown) so tool calls reach the cycle', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const callStep: Step = {
      type: 'function_call',
      id: 'c1',
      name: 'get_weather',
      arguments: { location: 'Paris' },
    };
    const { client } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [
        { id: 'int_1', status: 'requires_action', steps: [callStep] },
      ],
    });

    // Polling stops on requires_action and returns it — no throw, no hang.
    const result = await runWithPolls(
      handler.createResponse({
        client: client as never,
        messages: [userStep('a')],
        temperature: 0,
      }),
      1,
    );

    expect(result.response.status).toBe('requires_action');
    expect(handler.extractToolUse(result.response).map((c) => c.name)).toEqual([
      'get_weather',
    ]);
  });

  it('B9: timeout guard throws after the max polling duration', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const { client } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [{ id: 'int_1', status: 'in_progress' }], // never completes
    });

    const promise = handler.createResponse({
      client: client as never,
      messages: [userStep('a')],
      temperature: 0,
    });
    // Assert the cap value too, so a regression in BACKGROUND_MAX_DURATION_MS
    // (3h) is caught, not just the presence of a timeout message.
    const rejection = expect(promise).rejects.toThrow(
      new RegExp(`maximum polling duration of ${MAX_DURATION_MS} ms`),
    );

    // Drive well past the 3h cap (one get() recomputes elapsed time).
    const ticks = Math.ceil(MAX_DURATION_MS / POLL_INTERVAL_MS) + 2;
    for (let i = 0; i < ticks; i += 1) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }
    await rejection;
  });

  it('B10: background (workflow) and input-token compaction (tool-use) are mutually exclusive', async () => {
    // Background eligibility is workflow-only (isBackgroundModeEligible ===
    // isWorkflowMode), while input-token compaction (shouldCompactByInputTokens)
    // fires only in tool-use mode. So a TOOL-USE handler with both toggles on
    // does NOT use background: it takes the non-background path and compaction
    // composes there exactly as in the chaining suite. This documents that
    // composition: background never suppresses or duplicates compaction because
    // they cannot co-occur, and the non-background path's withUpdated still
    // surfaces updatedMessages.
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler(AgentCategory.ToolUse);
    handler.requestCompaction();

    expect(handler.isBackgroundModeActive()).toBe(false);

    const { client, calls } = bgClient({
      submit: () => completedInteraction('int_1'),
      getSequence: [completedInteraction('int_1')],
      generateContent: async () => ({
        text: 'SUMMARY',
        usageMetadata: { candidatesTokenCount: 5 },
      }),
    });

    const messages: Step[] = [userStep('a'), userStep('b'), userStep('c')];
    const result = await runWithPolls(
      handler.createResponse({
        client: client as never,
        messages,
        temperature: 0,
      }),
      1,
    );

    // Compaction ran on the non-background path; updatedMessages surfaced.
    expect(result.updatedMessages).toBeDefined();
    expect(result.updatedMessages!.length).toBeLessThan(messages.length);
    // Non-background submit carries the compacted transcript and no chain.
    expect(calls.create[0].background).toBeFalsy();
    expect(calls.create[0].previousId).toBeUndefined();
    expect(calls.create[0].input).toEqual(result.updatedMessages);
    // No background polling happened.
    expect(calls.get).toHaveLength(0);
  });

  it('B11: a model that rejects background:true falls back to the foreground path', async () => {
    // Verified live: gemini-2.5-flash returns HTTP 400 "does not support
    // background interactions". The handler must disable background for the
    // instance and retry without it (no allowlist needed).
    mockConfig();
    const handler = createHandler();

    const createParams: Array<{ background?: boolean }> = [];
    let getCalls = 0;
    const client = {
      interactions: {
        create: async (params: { background?: boolean; input: Step[] }) => {
          createParams.push({ background: params.background });
          if (params.background) {
            throw Object.assign(
              new Error(
                "Model 'gemini-2.5-flash' does not support background interactions.",
              ),
              { status: 400 },
            );
          }
          return completedInteraction('int_fg', 'fixed');
        },
        get: async (id: string) => {
          getCalls += 1;
          return completedInteraction(id);
        },
        cancel: async () => ({}),
      },
      models: {},
    };

    const result = await handler.createResponse({
      client: client as never,
      messages: [userStep('a')],
      temperature: 0,
    });

    // First create attempted background; the retry ran foreground (no background).
    expect(createParams).toHaveLength(2);
    expect(createParams[0].background).toBe(true);
    expect(createParams[1].background).toBeFalsy();
    // Foreground path returned a normal completion; no polling occurred.
    expect(result.response.status).toBe('completed');
    expect(getCalls).toBe(0);
    // Background stays disabled for the rest of the run.
    expect(handler.isBackgroundModeActive()).toBe(false);
  });
});
