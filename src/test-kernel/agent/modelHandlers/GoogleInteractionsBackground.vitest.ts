// Third-party imports
import { ApiError, type Interactions } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { hasManualRetryOnlyErrorMarker } from '@common/errors/sdkError/errorMetadata';
import {
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import { AgentCategory } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as configModule from '@utils/config/configUtils';
import * as providerConfigModule from '@utils/config/providerConfig';

// Local file imports
import {
  GOOGLE_INTERACTIONS_TEST_CONFIG,
  userStep,
} from './googleInteractionsTestUtils';

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
  beforeGet?: (index: number) => void | Promise<void>;
  onCancel?: (id: string) => void | Promise<void>;
  compaction?: () => Interaction;
  countTokens?: (params: unknown) => Promise<unknown>;
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
        if (
          opts.compaction &&
          params.store === false &&
          params.stream === false
        ) {
          return opts.compaction();
        }
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
        await opts.beforeGet?.(getIdx);
        const next =
          opts.getSequence[Math.min(getIdx, opts.getSequence.length - 1)];
        getIdx += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      cancel: async (id: string) => {
        calls.cancel.push(id);
        await opts.onCancel?.(id);
        return {};
      },
    },
    models: {
      ...(opts.countTokens ? { countTokens: opts.countTokens } : {}),
    },
  };
  return { client, calls };
}

/** Workflow-mode handler so isBackgroundModeEligible() is true. */
function createHandler(
  category: AgentCategory = AgentCategory.Workflow,
  supportsTokenCounting = false,
): ModelHandlerGoogleInteractions {
  const handler = new ModelHandlerGoogleInteractions(
    buildTestModelConfig(GOOGLE_INTERACTIONS_TEST_CONFIG, {
      capabilities: {
        supportsReasoning: true,
        supportsTokenCounting,
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
    serverState?: boolean | (() => boolean);
    background?: boolean | (() => boolean);
  } = {},
): void {
  const serverState = opts.serverState ?? true;
  const background = opts.background ?? true;
  vi.spyOn(configModule, 'getConfig').mockImplementation(
    <T>(key: string, defaultValue?: T): T => {
      if (key === 'texra.model.useGoogleInteractionsServerState') {
        return (
          typeof serverState === 'function' ? serverState() : serverState
        ) as T;
      }
      if (key === 'texra.model.useBackgroundResponses') {
        return (
          typeof background === 'function' ? background() : background
        ) as T;
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

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected promise to reject');
}

/** Mock the gating settings (both ON unless overridden) and arm fake timers. */
function useBackgroundTimers(opts?: Parameters<typeof mockConfig>[0]): void {
  mockConfig(opts);
  vi.useFakeTimers();
}

/**
 * Submit, let the first retrieval poll fail, and await the rejection. Returns
 * the rejection so tests can assert error specifics; `errorText` (when given)
 * must be a substring of the rejection message.
 */
async function failFirstRetrieval(
  handler: ModelHandlerGoogleInteractions,
  client: unknown,
  errorText?: string,
  messages: Step[] = [userStep('a')],
): Promise<Error> {
  const rejection = captureRejection(respond(handler, client, messages));
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  const error = await rejection;
  if (errorText !== undefined) expect(error.message).toContain(errorText);
  return error;
}

/** Retry once after a failed poll and assert the create/get/cancel ledger. */
async function expectRetryLedger(
  handler: ModelHandlerGoogleInteractions,
  client: unknown,
  calls: CapturedCalls,
  expected: { creates: number; gets: string[] },
): Promise<void> {
  await respond(handler, client, [userStep('a')]);
  expect(calls.create).toHaveLength(expected.creates);
  expect(calls.get).toEqual(expected.gets);
  expect(calls.cancel).toHaveLength(0);
}

describe('ModelHandlerGoogleInteractions background mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('B1: background submit sets background:true + store:true + stream:false', async () => {
    useBackgroundTimers();
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
    useBackgroundTimers();
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

    expect(calls.get).toEqual(['int_1', 'int_1', 'int_1']);
    expect(result.response.status).toBe('completed');
  });

  it('resumes the same interaction after a transient get failure', async () => {
    useBackgroundTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_resume', status: 'in_progress' }),
      getSequence: [
        new TypeError('fetch failed'),
        completedInteraction('int_resume'),
      ],
    });

    await failFirstRetrieval(handler, client, 'fetch failed');

    await expect(
      runWithPolls(respond(handler, client, [userStep('a')]), 1),
    ).resolves.toMatchObject({ response: { status: 'completed' } });

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_resume', 'int_resume']);
    expect(calls.cancel).toHaveLength(0);
  });

  it('clears the submitted lifecycle id when resumed completion returns a different id', async () => {
    useBackgroundTimers();
    const handler = createHandler();
    const messages = [userStep('a')];
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_submitted', status: 'in_progress' }),
      getSequence: [
        new TypeError('fetch failed'),
        completedInteraction('int_returned'),
      ],
    });

    await failFirstRetrieval(handler, client, 'fetch failed', messages);
    await respond(handler, client, messages);

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_submitted', 'int_submitted']);
    expect(calls.cancel).toHaveLength(0);

    const { client: nextClient, calls: nextCalls } = bgClient({
      submit: () => completedInteraction('int_next'),
      getSequence: [completedInteraction('int_submitted')],
    });
    messages.push(userStep('b'));
    await respond(handler, nextClient, messages);

    expect(nextCalls.create).toHaveLength(1);
    expect(nextCalls.create[0].previousId).toBe('int_returned');
    expect(nextCalls.get).toHaveLength(0);
    expect(nextCalls.cancel).toHaveLength(0);
  });

  it('resumes a pending interaction when background is disabled and preserves its chain', async () => {
    let background = true;
    useBackgroundTimers({ background: () => background });
    const handler = createHandler();
    const messages = [userStep('a')];
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_background_resume', status: 'in_progress' }),
      getSequence: [
        new TypeError('fetch failed'),
        completedInteraction('int_background_resume'),
      ],
    });

    await failFirstRetrieval(handler, client, 'fetch failed', messages);

    background = false;
    await expect(respond(handler, client, messages)).resolves.toMatchObject({
      response: { status: 'completed' },
    });

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual([
      'int_background_resume',
      'int_background_resume',
    ]);
    expect(calls.cancel).toHaveLength(0);

    const { client: nextClient, calls: nextCalls } = bgClient({
      submit: () => completedInteraction('int_after_background_change'),
      getSequence: [completedInteraction('int_after_background_change')],
    });
    messages.push(userStep('b'));
    await respond(handler, nextClient, messages);
    expect(nextCalls.create[0].previousId).toBe('int_background_resume');
    expect(nextCalls.create[0].input).toEqual([messages[1]]);
  });

  it.each(['completed', 'missing'] as const)(
    'invalidates an existing chain before a disabled-server-state resume ends %s',
    async (outcome) => {
      let serverState = true;
      useBackgroundTimers({ serverState: () => serverState });
      const handler = createHandler();
      const messages = [userStep('a')];

      const { client: chainClient, calls: chainCalls } = bgClient({
        submit: () => ({ id: 'int_chain', status: 'in_progress' }),
        getSequence: [completedInteraction('int_chain')],
      });
      await runWithPolls(respond(handler, chainClient, messages), 1);
      expect(chainCalls.create).toHaveLength(1);
      expect(chainCalls.get).toEqual(['int_chain']);
      expect(chainCalls.cancel).toHaveLength(0);

      messages.push(userStep('b'));
      const resumeResult =
        outcome === 'completed'
          ? completedInteraction('int_pending_turn')
          : new ApiError({ message: 'gone', status: 404 });
      const { client: pendingClient, calls: pendingCalls } = bgClient({
        submit: () => ({ id: 'int_pending_turn', status: 'in_progress' }),
        getSequence: [new TypeError('fetch failed'), resumeResult],
      });
      await failFirstRetrieval(
        handler,
        pendingClient,
        'fetch failed',
        messages,
      );
      expect(pendingCalls.create[0].previousId).toBe('int_chain');

      serverState = false;
      if (outcome === 'completed') {
        await expect(
          respond(handler, pendingClient, messages),
        ).resolves.toMatchObject({ response: { status: 'completed' } });
        messages.push(userStep('c'));
      } else {
        const missing = await captureRejection(
          respond(handler, pendingClient, messages),
        );
        expect(hasManualRetryOnlyErrorMarker(missing)).toBe(true);
        expect(isProviderErrorAutoRetryable(missing)).toBe(false);
      }

      expect(pendingCalls.create).toHaveLength(1);
      expect(pendingCalls.get).toEqual([
        'int_pending_turn',
        'int_pending_turn',
      ]);
      expect(pendingCalls.cancel).toHaveLength(0);

      serverState = true;
      const { client: nextClient, calls: nextCalls } = bgClient({
        submit: () => completedInteraction('int_after_server_state_change'),
        getSequence: [completedInteraction('int_after_server_state_change')],
      });
      await respond(handler, nextClient, messages);
      expect(nextCalls.create).toHaveLength(1);
      expect(nextCalls.create[0].previousId).toBeUndefined();
      expect(nextCalls.create[0].input).toEqual(messages);
      expect(nextCalls.get).toHaveLength(0);
      expect(nextCalls.cancel).toHaveLength(0);
    },
  );

  it('keeps the original id through a transient failure, in_progress, and completion', async () => {
    useBackgroundTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_long_resume', status: 'in_progress' }),
      getSequence: [
        Object.assign(new Error('temporarily unavailable'), { status: 503 }),
        { id: 'int_long_resume', status: 'in_progress' },
        completedInteraction('int_long_resume'),
      ],
    });

    await failFirstRetrieval(handler, client, 'temporarily unavailable');

    await runWithPolls(respond(handler, client, [userStep('a')]), 1);

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual([
      'int_long_resume',
      'int_long_resume',
      'int_long_resume',
    ]);
    expect(calls.cancel).toHaveLength(0);
  });

  it('does not reset the original deadline when a retry resumes', async () => {
    mockConfig();
    vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_expire', status: 'in_progress' }),
      getSequence: [new TypeError('fetch failed')],
    });

    await failFirstRetrieval(handler, client);

    await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - POLL_INTERVAL_MS);
    const timeout = await captureRejection(
      respond(handler, client, [userStep('a')]),
    );

    expect(timeout.message).toContain(
      `maximum polling duration of ${MAX_DURATION_MS} ms`,
    );
    expect(hasManualRetryOnlyErrorMarker(timeout)).toBe(true);
    expect(normalizeProviderError(timeout).userRetryable).toBe(true);
    expect(isProviderErrorAutoRetryable(timeout)).toBe(false);
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_expire']);
    expect(calls.cancel).toEqual(['int_expire']);
  });

  it.each([
    {
      outcome: completedInteraction('int_late'),
      outcomeLabel: 'returns',
    },
    { outcome: new TypeError('late failure'), outcomeLabel: 'rejects' },
  ])(
    'rejects a resumed retrieval that $outcomeLabel after the original deadline',
    async ({ outcome }) => {
      mockConfig();
      const startedAt = new Date('2026-08-01T00:00:00.000Z');
      vi.useFakeTimers({ now: startedAt });
      const handler = createHandler();
      const { client, calls } = bgClient({
        submit: () => ({ id: 'int_late', status: 'in_progress' }),
        getSequence: [new TypeError('fetch failed'), outcome],
        beforeGet: (index) => {
          if (index === 1) {
            vi.setSystemTime(startedAt.getTime() + MAX_DURATION_MS);
          }
        },
      });

      await failFirstRetrieval(handler, client);

      vi.setSystemTime(startedAt.getTime() + MAX_DURATION_MS - 1);
      const timeout = await captureRejection(
        respond(handler, client, [userStep('a')]),
      );

      expect(timeout.message).toContain(
        `maximum polling duration of ${MAX_DURATION_MS} ms`,
      );
      expect(hasManualRetryOnlyErrorMarker(timeout)).toBe(true);
      expect(calls.create).toHaveLength(1);
      expect(calls.get).toEqual(['int_late', 'int_late']);
      expect(calls.cancel).toEqual(['int_late']);
    },
  );

  it.each([
    {
      outcome: completedInteraction('int_late_abort'),
      outcomeLabel: 'returns',
    },
    { outcome: new TypeError('late failure'), outcomeLabel: 'rejects' },
  ])(
    'cancels when a resumed retrieval $outcomeLabel after user abort',
    async ({ outcome }) => {
      useBackgroundTimers();
      const handler = createHandler();
      const controller = new AbortController();
      const { client, calls } = bgClient({
        submit: () => ({ id: 'int_late_abort', status: 'in_progress' }),
        getSequence: [new TypeError('fetch failed'), outcome],
        beforeGet: (index) => {
          if (index === 1) controller.abort();
        },
      });

      await failFirstRetrieval(handler, client);

      await expect(
        respond(handler, client, [userStep('a')], controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await Promise.resolve();

      expect(calls.create).toHaveLength(1);
      expect(calls.get).toEqual(['int_late_abort', 'int_late_abort']);
      expect(calls.cancel).toEqual(['int_late_abort']);
    },
  );

  it('cancels before resumed retrieval when token counting observes abort', async () => {
    useBackgroundTimers();
    const controller = new AbortController();
    let countCalls = 0;
    const countTokens = vi.fn(async () => {
      countCalls += 1;
      if (countCalls === 2) controller.abort();
      return { totalTokens: 1 };
    });
    const handler = createHandler(AgentCategory.Workflow, true);
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_abort_before_resume', status: 'in_progress' }),
      getSequence: [new TypeError('fetch failed')],
      countTokens,
    });

    await failFirstRetrieval(handler, client);

    await expect(
      respond(handler, client, [userStep('a')], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();

    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_abort_before_resume']);
    expect(calls.cancel).toEqual(['int_abort_before_resume']);
  });

  it('clears a pre-aborted pending interaction before token counting', async () => {
    useBackgroundTimers();
    const handler = createHandler(AgentCategory.Workflow, true);
    let releaseCancel!: () => void;
    const cancelPending = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const countTokens = vi.fn(
      async (params: { config?: { abortSignal?: AbortSignal } }) => {
        params.config?.abortSignal?.throwIfAborted();
        return { totalTokens: 1 };
      },
    );
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_abort_before_count', status: 'in_progress' }),
      getSequence: [new TypeError('fetch failed')],
      countTokens: countTokens as (params: unknown) => Promise<unknown>,
      onCancel: () => cancelPending,
    });

    await failFirstRetrieval(handler, client, 'fetch failed');
    expect(countTokens).toHaveBeenCalledTimes(1);
    countTokens.mockClear();

    const controller = new AbortController();
    controller.abort();
    let settled = false;
    let caught: unknown;
    const retry = respond(
      handler,
      client,
      [userStep('a')],
      controller.signal,
    ).catch((error: unknown) => {
      settled = true;
      caught = error;
    });
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    const settledBeforeCancel = settled;
    releaseCancel();
    await retry;

    expect(settledBeforeCancel).toBe(true);
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(countTokens).not.toHaveBeenCalled();
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_abort_before_count']);
    expect(calls.cancel).toEqual(['int_abort_before_count']);
  });

  it('lets an already-aborted signal win over pending expiry without awaiting cancel', async () => {
    mockConfig();
    vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
    const handler = createHandler();
    let releaseCancel!: () => void;
    const cancelPending = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_abort_expired', status: 'in_progress' }),
      getSequence: [new TypeError('fetch failed')],
      onCancel: () => cancelPending,
    });

    await failFirstRetrieval(handler, client, 'fetch failed');
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MS - POLL_INTERVAL_MS);

    const controller = new AbortController();
    controller.abort();
    let settled = false;
    let caught: unknown;
    const retry = respond(
      handler,
      client,
      [userStep('a')],
      controller.signal,
    ).catch((error: unknown) => {
      settled = true;
      caught = error;
    });
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    const settledBeforeCancel = settled;
    releaseCancel();
    await retry;

    expect(settledBeforeCancel).toBe(true);
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_abort_expired']);
    expect(calls.cancel).toEqual(['int_abort_expired']);
  });

  it('rethrows a retrieval abort without awaiting best-effort cancel', async () => {
    useBackgroundTimers();
    const handler = createHandler();
    let releaseCancel!: () => void;
    const cancelPending = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const retrievalAbort = new DOMException('stopped', 'AbortError');
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_retrieval_abort', status: 'in_progress' }),
      getSequence: [new TypeError('fetch failed'), retrievalAbort],
      onCancel: () => cancelPending,
    });

    await failFirstRetrieval(handler, client, 'fetch failed');

    let settled = false;
    let caught: unknown;
    const retry = respond(handler, client, [userStep('a')]).catch(
      (error: unknown) => {
        settled = true;
        caught = error;
      },
    );
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    const settledBeforeCancel = settled;
    releaseCancel();
    await retry;

    expect(settledBeforeCancel).toBe(true);
    expect(caught).toBe(retrievalAbort);
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_retrieval_abort', 'int_retrieval_abort']);
    expect(calls.cancel).toEqual(['int_retrieval_abort']);
  });

  it('treats queued as pending', async () => {
    useBackgroundTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_queued', status: 'queued' }),
      getSequence: [
        { id: 'int_queued', status: 'queued' },
        completedInteraction('int_queued'),
      ],
    });

    await runWithPolls(respond(handler, client, [userStep('a')]), 2);

    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_queued', 'int_queued']);
  });

  it('retains an unknown status but requires manual retry before another poll', async () => {
    useBackgroundTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_unknown', status: 'in_progress' }),
      getSequence: [
        { id: 'int_unknown', status: 'mystery' },
        completedInteraction('int_unknown'),
      ],
    });

    const unknown = await failFirstRetrieval(handler, client);

    expect(unknown.message).toMatch(/unknown status "mystery"/);
    expect(hasManualRetryOnlyErrorMarker(unknown)).toBe(true);
    expect(normalizeProviderError(unknown).provider).toBe('google');
    expect(isProviderErrorAutoRetryable(unknown)).toBe(false);
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_unknown']);
    expect(calls.cancel).toHaveLength(0);

    await expectRetryLedger(handler, client, calls, {
      creates: 1,
      gets: ['int_unknown', 'int_unknown'],
    });
  });

  it('retains a known id after a non-missing 4xx retrieval failure', async () => {
    useBackgroundTimers();
    const handler = createHandler();
    const forbidden = Object.assign(new Error('request rejected'), {
      status: 403,
    });
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_forbidden', status: 'in_progress' }),
      getSequence: [forbidden, completedInteraction('int_forbidden')],
    });

    const firstError = await failFirstRetrieval(handler, client);

    expect(firstError).toBe(forbidden);
    expect(isProviderErrorAutoRetryable(firstError)).toBe(false);
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_forbidden']);
    expect(calls.cancel).toHaveLength(0);

    await expectRetryLedger(handler, client, calls, {
      creates: 1,
      gets: ['int_forbidden', 'int_forbidden'],
    });
  });

  it.each([404, 410])(
    'clears a definitively missing interaction on HTTP %i and requires manual retry',
    async (status) => {
      useBackgroundTimers();
      const handler = createHandler();
      let submitCount = 0;
      const { client, calls } = bgClient({
        submit: () => ({
          id: `int_missing_${++submitCount}`,
          status: submitCount === 1 ? 'in_progress' : 'completed',
        }),
        getSequence: [
          new ApiError({ message: 'gone', status }),
          completedInteraction('unused'),
        ],
      });

      const missing = await failFirstRetrieval(handler, client);

      expect(hasManualRetryOnlyErrorMarker(missing)).toBe(true);
      expect(normalizeProviderError(missing).userRetryable).toBe(true);
      expect(isProviderErrorAutoRetryable(missing)).toBe(false);
      expect(calls.create).toHaveLength(1);
      expect(calls.get).toEqual(['int_missing_1']);
      expect(calls.cancel).toHaveLength(0);

      await expectRetryLedger(handler, client, calls, {
        creates: 2,
        gets: ['int_missing_1'],
      });
    },
  );

  it.each([
    {
      label: 'SDK INVALID_ARGUMENT previous_interaction_id error',
      error: Object.assign(
        new ApiError({
          message: 'Invalid previous_interaction_id int_stale',
          status: 400,
        }),
        { code: 'INVALID_ARGUMENT' },
      ),
    },
    {
      label: 'SDK FAILED_PRECONDITION expired interaction error',
      error: Object.assign(
        new ApiError({
          message: 'Interaction int_stale is expired',
          status: 400,
        }),
        { code: 'FAILED_PRECONDITION' },
      ),
    },
  ])('clears pending identity for a $label', async ({ error }) => {
    useBackgroundTimers();
    const handler = createHandler();
    let submitCount = 0;
    const { client, calls } = bgClient({
      submit: () => {
        submitCount += 1;
        return submitCount === 1
          ? { id: 'int_stale', status: 'in_progress' }
          : completedInteraction('int_after_stale');
      },
      getSequence: [error],
    });

    const stale = await failFirstRetrieval(handler, client);

    expect(hasManualRetryOnlyErrorMarker(stale)).toBe(true);
    expect(normalizeProviderError(stale).provider).toBe('google');
    expect(isProviderErrorAutoRetryable(stale)).toBe(false);
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['int_stale']);
    expect(calls.cancel).toHaveLength(0);

    await expectRetryLedger(handler, client, calls, {
      creates: 2,
      gets: ['int_stale'],
    });
  });

  it.each(['failed', 'cancelled', 'incomplete', 'budget_exceeded'])(
    'clears terminal status %s and prevents automatic replacement',
    async (status) => {
      useBackgroundTimers();
      const handler = createHandler();
      let submitCount = 0;
      const { client, calls } = bgClient({
        submit: () => {
          submitCount += 1;
          return submitCount === 1
            ? { id: 'int_terminal', status: 'in_progress' }
            : completedInteraction('int_after_terminal');
        },
        getSequence: [{ id: 'int_terminal', status }],
      });

      const terminal = await failFirstRetrieval(handler, client);

      expect(terminal.message).toContain(`status "${status}"`);
      expect(hasManualRetryOnlyErrorMarker(terminal)).toBe(true);
      expect(normalizeProviderError(terminal).userRetryable).toBe(true);
      expect(isProviderErrorAutoRetryable(terminal)).toBe(false);
      expect(calls.create).toHaveLength(1);
      expect(calls.get).toEqual(['int_terminal']);
      expect(calls.cancel).toHaveLength(0);

      await expectRetryLedger(handler, client, calls, {
        creates: 2,
        gets: ['int_terminal'],
      });
    },
  );

  it('B3: captures the chain id from the polled completion (not the submit)', async () => {
    useBackgroundTimers();
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
    useBackgroundTimers();
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
    const { client: client2, calls: calls2 } = bgClient({
      submit: () => completedInteraction('int_2'),
      getSequence: [completedInteraction('int_2')],
    });
    await expect(
      runWithPolls(respond(handler, client2, [userStep('b')]), 1),
    ).resolves.toBeDefined();
    expect(calls2.create).toHaveLength(1);
    expect(calls2.get).toHaveLength(0);

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
    useBackgroundTimers({ serverState: false, background: true });
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
    useBackgroundTimers({ serverState: true, background: false });
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
    useBackgroundTimers();
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
    useBackgroundTimers();
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
    useBackgroundTimers();
    const handler = createHandler();
    const { client, calls } = bgClient({
      submit: () => ({ id: 'int_1', status: 'in_progress' }),
      getSequence: [{ id: 'int_1', status: 'in_progress' }], // never completes
    });

    const promise = respond(handler, client, [userStep('a')]);
    const timeoutPromise = captureRejection(promise);

    // Drive well past the 3h cap (one get() recomputes elapsed time).
    const ticks = Math.ceil(MAX_DURATION_MS / POLL_INTERVAL_MS) + 2;
    for (let i = 0; i < ticks; i += 1) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }
    const timeout = await timeoutPromise;
    expect(timeout.message).toContain(
      `maximum polling duration of ${MAX_DURATION_MS} ms`,
    );
    expect(hasManualRetryOnlyErrorMarker(timeout)).toBe(true);
    expect(isProviderErrorAutoRetryable(timeout)).toBe(false);
    expect(calls.cancel).toEqual(['int_1']);
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
    useBackgroundTimers();
    const handler = createHandler(AgentCategory.ToolUse);
    handler.requestCompaction();

    expect(handler.isBackgroundModeActive()).toBe(false);

    const { client, calls } = bgClient({
      submit: () => completedInteraction('int_1'),
      getSequence: [completedInteraction('int_1')],
      compaction: () => ({
        ...completedInteraction('compact', 'SUMMARY'),
        usage: { total_output_tokens: 5 },
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
});
