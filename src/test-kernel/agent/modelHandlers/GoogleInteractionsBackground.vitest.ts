// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import {
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkErrorUtils';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as configModule from '@utils/config/configUtils';
import * as providerConfigModule from '@utils/config/providerConfig';

// Local file imports
import {
  GOOGLE_INTERACTIONS_TEST_CONFIG,
  userStep,
} from './googleInteractionsTestUtils';

// Third-party imports
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
  getSequence: Array<Interaction | Error>;
  onCancel?: (id: string) => void;
  beforeGet?: (index: number) => void;
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
        opts.beforeGet?.(getIdx);
        const next =
          opts.getSequence[Math.min(getIdx, opts.getSequence.length - 1)];
        getIdx += 1;
        if (next instanceof Error) throw next;
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
    buildTestModelConfig(GOOGLE_INTERACTIONS_TEST_CONFIG, {
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

/** Shorthand for the `createResponse` call every test makes (the fake `client`
 * never matches the SDK client type, hence the `as never` cast). */
function respond(
  handler: ModelHandlerGoogleInteractions,
  client: unknown,
  messages: Step[],
  signal?: AbortSignal,
) {
  return handler.createResponse({
    client: client as never,
    messages,
    temperature: 0,
    signal,
  });
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

    const promise = respond(handler, client, [userStep('a')]);
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

    const promise = respond(handler, client, [userStep('a')]);
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
    await runWithPolls(respond(handler, client, messages), 2);

    // Second turn: chained submit is immediately completed (no polling needed).
    const { client: client2, calls: calls2 } = bgClient({
      submit: () => completedInteraction('int_done2'),
      getSequence: [completedInteraction('int_done2')],
    });
    messages.push(userStep('b'));
    await runWithPolls(respond(handler, client2, messages), 1);

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

    const promise = respond(
      handler,
      client,
      [userStep('a')],
      controller.signal,
    );
    const rejection = expect(promise).rejects.toThrow();

    // Allow the submit + first poll wait to begin, then abort.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await rejection;

    expect(calls.cancel).toEqual(['int_1']);

    // No leak: a fresh serial call on the same handler succeeds.
    const { client: client2 } = bgClient({
      submit: () => completedInteraction('int_2'),
      getSequence: [completedInteraction('int_2')],
    });
    await expect(
      runWithPolls(respond(handler, client2, [userStep('b')]), 1),
    ).resolves.toBeDefined();

    // A later abort cancels ITS OWN interaction, never the earlier one: the
    // cancel target is the id captured by that poll invocation, so no handler
    // state can point a second abort at a stale interaction.
    const controller3 = new AbortController();
    const { client: client3, calls: calls3 } = bgClient({
      submit: () => ({ id: 'int_3', status: 'in_progress' }),
      getSequence: [{ id: 'int_3', status: 'in_progress' }],
    });
    const promise3 = respond(
      handler,
      client3,
      [userStep('c')],
      controller3.signal,
    );
    const rejection3 = expect(promise3).rejects.toThrow();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    controller3.abort();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await rejection3;

    expect(calls3.cancel).toEqual(['int_3']);
    expect(calls.cancel).toEqual(['int_1']);
  });

  it('B5: background + stateless takes the non-background path', async () => {
    mockConfig({ serverState: false, background: true });
    vi.useFakeTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => completedInteraction('int_1'),
      getSequence: [completedInteraction('int_1')],
    });

    await runWithPolls(respond(handler, client, [userStep('a')]), 1);

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

    await runWithPolls(respond(handler, client, [userStep('a')]), 1);

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

    const promise = respond(handler, client, [userStep('a')]);
    const rejection = expect(promise).rejects.toThrow(/status "failed"/);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await rejection;

    // Next turn full-resends (chain never established).
    const { client: client2, calls: calls2 } = bgClient({
      submit: () => completedInteraction('int_2'),
      getSequence: [completedInteraction('int_2')],
    });
    await runWithPolls(
      respond(handler, client2, [userStep('a'), userStep('b')]),
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
      respond(handler, client, [userStep('a')]),
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

    const promise = respond(handler, client, [userStep('a')]);
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
    const result = await runWithPolls(respond(handler, client, messages), 1);

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

    const result = await respond(handler, client, [userStep('a')]);

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

  it('B12: a transient poll failure resumes the same interaction without another submit', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const transient = new Error('connection reset');
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [transient, completedInteraction('int_1', 'resumed')],
    });

    const first = respond(handler, client, [userStep('a')]);
    const firstRejection = expect(first).rejects.toThrow('connection reset');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await firstRejection;

    const second = respond(handler, client, [userStep('a')]);
    const result = await runWithPolls(second, 2);

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_1', 'int_1']);
    expect(result.response.id).toBe('int_1');
    expect(result.response.status).toBe('completed');
  });

  it.each([404, 410])(
    'B13: an unavailable acknowledged interaction (%i) requires explicit retry before replacement',
    async (status) => {
      mockConfig();
      vi.useFakeTimers();
      const handler = createHandler();
      const missing = Object.assign(new Error('interaction not found'), {
        status,
      });
      const { client, calls } = bgClient({
        submit: () => ({ id: 'int_1', status: 'in_progress' }),
        getSequence: [new Error('connection reset'), missing],
      });

      const first = respond(handler, client, [userStep('a')]);
      const firstRejection = expect(first).rejects.toThrow('connection reset');
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await firstRejection;

      const secondError = await respond(handler, client, [userStep('a')]).catch(
        (error: unknown) => error,
      );

      expect(calls.create).toHaveLength(1);
      expect(secondError).toBeInstanceOf(Error);
      expect((secondError as Error).message).toMatch(/Retry explicitly/);
      expect(isProviderErrorAutoRetryable(secondError)).toBe(false);
      expect(normalizeProviderError(secondError).provider).toBe('google');

      // A later explicit invocation may submit a replacement after the missing
      // interaction has been accounted for and removed from local tracking.
      const { client: replacementClient, calls: replacementCalls } = bgClient({
        submit: () => completedInteraction('int_2', 'replacement'),
        getSequence: [completedInteraction('int_2', 'replacement')],
      });
      const result = await respond(handler, replacementClient, [userStep('a')]);
      expect(replacementCalls.create).toHaveLength(1);
      expect(result.response.id).toBe('int_2');
    },
  );

  it('B14: resumed polling keeps the original lifetime deadline', async () => {
    mockConfig();
    vi.useFakeTimers();
    const startedAt = Date.now();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [new Error('connection reset')],
    });

    const first = respond(handler, client, [userStep('a')]);
    const firstRejection = expect(first).rejects.toThrow('connection reset');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await firstRejection;

    vi.setSystemTime(startedAt + MAX_DURATION_MS);
    const timeout = await respond(handler, client, [userStep('a')]).catch(
      (error: unknown) => error,
    );
    await Promise.resolve();

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_1']);
    expect(calls.cancel).toEqual(['int_1']);
    expect(timeout).toBeInstanceOf(Error);
    expect((timeout as Error).message).toMatch(
      new RegExp(`maximum polling duration of ${MAX_DURATION_MS} ms`),
    );
    expect(isProviderErrorAutoRetryable(timeout)).toBe(false);
  });

  it('B15: a retrieval that finishes after the original deadline cannot succeed late', async () => {
    mockConfig();
    vi.useFakeTimers();
    const startedAt = Date.now();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [
        new Error('connection reset'),
        completedInteraction('int_1', 'too late'),
      ],
      beforeGet: (index) => {
        if (index === 1) vi.setSystemTime(startedAt + MAX_DURATION_MS);
      },
    });

    const first = respond(handler, client, [userStep('a')]);
    const firstRejection = expect(first).rejects.toThrow('connection reset');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await firstRejection;

    vi.setSystemTime(startedAt + MAX_DURATION_MS - 1);
    const timeout = await respond(handler, client, [userStep('a')]).catch(
      (error: unknown) => error,
    );
    await Promise.resolve();

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_1', 'int_1']);
    expect(calls.cancel).toEqual(['int_1']);
    expect(timeout).toBeInstanceOf(Error);
    expect(isProviderErrorAutoRetryable(timeout)).toBe(false);
  });

  it.each([404, 410])(
    'B16: an unavailable response (%i) during the first poll cannot trigger an automatic replacement',
    async (status) => {
      mockConfig();
      vi.useFakeTimers();
      const handler = createHandler();
      const missing = Object.assign(new Error('interaction not found'), {
        status,
      });
      const { client, calls } = bgClient({
        submit: () => ({ id: 'int_1', status: 'in_progress' }),
        getSequence: [missing],
      });

      const response = respond(handler, client, [userStep('a')]);
      const errorPromise = response.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      const error = await errorPromise;

      expect(calls.create).toHaveLength(1);
      expect(calls.get).toEqual(['int_1']);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Retry explicitly/);
      expect(isProviderErrorAutoRetryable(error)).toBe(false);
    },
  );

  it('B17: an already-aborted resume cancels the retained interaction', async () => {
    mockConfig();
    vi.useFakeTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [new Error('connection reset')],
    });

    const first = respond(handler, client, [userStep('a')]);
    const firstRejection = expect(first).rejects.toThrow('connection reset');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await firstRejection;

    const controller = new AbortController();
    controller.abort();
    await expect(
      respond(handler, client, [userStep('a')], controller.signal),
    ).rejects.toThrow();
    await Promise.resolve();

    expect(calls.create).toHaveLength(1);
    expect(calls.cancel).toEqual(['int_1']);
  });
});
