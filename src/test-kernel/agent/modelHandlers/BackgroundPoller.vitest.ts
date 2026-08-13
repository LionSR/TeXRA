import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import {
  BackgroundPoller,
  type BackgroundPollStats,
} from '@agent/modelHandlers/support/BackgroundPoller';

interface TestResponse {
  id?: string;
  status: string;
  usage?: unknown;
}

function trace(): AgentTrace & { debug: Mock; error: Mock } {
  return {
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as AgentTrace & { debug: Mock; error: Mock };
}

const extractId = (response: TestResponse) => response.id;
const extractStatus = (response: TestResponse) => response.status;
const isInProgress = (response: TestResponse) =>
  response.status === 'in_progress';

const FROZEN_NOW = new Date('2026-08-01T00:00:00.000Z');

interface PollerOverrides {
  maxDurationMs: number;
  pollIntervalMs?: number;
  isPending?: (response: TestResponse) => boolean;
  logger?: AgentTrace | (() => AgentTrace);
}

function createPoller(
  overrides: PollerOverrides,
): BackgroundPoller<TestResponse> {
  return new BackgroundPoller<TestResponse>({
    pollIntervalMs: 0,
    isPending: isInProgress,
    logger: trace(),
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundPoller', () => {
  it('resolves the logger supplier at poll time', async () => {
    const staleLogger = trace();
    const activeLogger = trace();
    let logger = staleLogger;
    const poller = createPoller({
      maxDurationMs: 1000,
      isPending: () => false,
      logger: () => logger,
    });

    logger = activeLogger;
    await poller.poll({
      initialResponse: { id: 'resp-1', status: 'completed' },
      retrieve: vi.fn(),
      extractId,
      extractStatus,
      providerLabel: 'OpenAI',
    });

    expect(staleLogger.debug).not.toHaveBeenCalled();
    expect(activeLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('OpenAI polling started'),
      expect.anything(),
    );
  });

  it('uses provider-specific timeout guidance', async () => {
    const logger = trace();
    const poller = createPoller({ maxDurationMs: -1, logger });

    await expect(
      poller.poll({
        initialResponse: { id: 'resp-2', status: 'in_progress' },
        retrieve: vi.fn(),
        extractId,
        extractStatus,
        providerLabel: 'OpenAI',
        formatTimeoutError: ({ responseId, maxDurationMs }) =>
          `Cancel ${responseId} after ${maxDurationMs} ms with provider API.`,
      }),
    ).rejects.toThrow('Cancel resp-2 after -1 ms with provider API.');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('exceeded maximum polling duration'),
      expect.objectContaining({
        data: expect.objectContaining({
          responseId: 'resp-2',
          pollCount: 1,
          maxDurationMs: -1,
        }),
      }),
    );
  });

  it('honors a polling deadline established by an earlier invocation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T03:00:00Z'));
    const retrieve = vi.fn();
    const poller = createPoller({ maxDurationMs: 3 * 60 * 60 * 1000 });
    const timeout = new Error('terminal polling timeout');

    const polling = poller.poll({
      initialResponse: { id: 'resp-expired', status: 'in_progress' },
      retrieve,
      extractId,
      extractStatus,
      deadlineAtMs: new Date('2026-08-01T03:00:00Z').getTime(),
      formatTimeoutError: () => timeout,
    });
    const rejection = expect(polling).rejects.toBe(timeout);
    await vi.runAllTimersAsync();
    await rejection;
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('returns the timeout error when retrieval rejects at the deadline', async () => {
    vi.useFakeTimers({ now: FROZEN_NOW });
    const deadlineAtMs = Date.now() + 1;
    const retrieve = vi.fn(async () => {
      vi.setSystemTime(deadlineAtMs);
      throw new Error('socket hang up');
    });
    const poller = createPoller({ maxDurationMs: 1000 });
    const timeout = new Error('canonical polling timeout');

    const polling = poller.poll({
      initialResponse: { id: 'resp-late', status: 'in_progress' },
      retrieve,
      extractId,
      extractStatus,
      deadlineAtMs,
      formatTimeoutError: () => timeout,
    });
    const rejection = expect(polling).rejects.toBe(timeout);
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('rejects a retrieval result that arrives at the deadline', async () => {
    vi.useFakeTimers({ now: FROZEN_NOW });
    const deadlineAtMs = Date.now() + 1;
    const retrieve = vi.fn(async () => {
      vi.setSystemTime(deadlineAtMs);
      return { id: 'resp-late-result', status: 'completed' };
    });
    const poller = createPoller({ maxDurationMs: 1000 });

    const polling = poller.poll({
      initialResponse: { id: 'resp-late-result', status: 'in_progress' },
      retrieve,
      extractId,
      extractStatus,
      deadlineAtMs,
    });
    const rejection = expect(polling).rejects.toThrow(
      'exceeded maximum polling duration',
    );
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fulfills', false],
    ['rejects', true],
  ])(
    'preserves cancellation when a deadline-bound retrieval %s late',
    async (_label, rejects) => {
      vi.useFakeTimers({ now: FROZEN_NOW });
      const controller = new AbortController();
      const deadlineAtMs = Date.now() + 1;
      const poller = createPoller({ maxDurationMs: 1000 });

      const polling = poller.poll({
        initialResponse: { id: 'resp-aborted-late', status: 'in_progress' },
        retrieve: vi.fn(async () => {
          controller.abort();
          vi.setSystemTime(deadlineAtMs);
          if (rejects) throw new Error('socket hang up');
          return { id: 'resp-aborted-late', status: 'completed' };
        }),
        extractId,
        extractStatus,
        signal: controller.signal,
        deadlineAtMs,
      });
      const rejection = expect(polling).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.advanceTimersByTimeAsync(0);

      await rejection;
    },
  );

  it('times out the default poller exactly at its duration boundary', async () => {
    vi.useFakeTimers({ now: FROZEN_NOW });
    const retrieve = vi.fn(async () => ({
      id: 'resp-boundary',
      status: 'completed',
    }));
    const poller = createPoller({ maxDurationMs: 0 });

    const polling = poller.poll({
      initialResponse: { id: 'resp-boundary', status: 'in_progress' },
      retrieve,
      extractId,
      extractStatus,
    });
    const rejection = expect(polling).rejects.toThrow(
      'exceeded maximum polling duration',
    );
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('logs aborts that happen while waiting for the next poll', async () => {
    const logger = trace();
    const controller = new AbortController();
    const poller = createPoller({
      maxDurationMs: 10_000,
      pollIntervalMs: 1000,
      logger,
    });

    const promise = poller.poll({
      initialResponse: { id: 'int-1', status: 'in_progress' },
      retrieve: vi.fn(),
      extractId,
      extractStatus,
      signal: controller.signal,
      providerLabel: 'Google Interactions',
      resourceLabel: 'interaction',
    });
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(
      logger.debug.mock.calls.some(
        ([message]) =>
          typeof message === 'string' &&
          message.includes('aborted') &&
          message.includes('interaction int-1') &&
          message.includes('poll 1'),
      ),
    ).toBe(true);
  });

  it('logs final stats with provider usage data', async () => {
    const logger = trace();
    let finishedStats: BackgroundPollStats | undefined;
    const usage = { input_tokens: 3, output_tokens: 5 };
    const poller = createPoller({ maxDurationMs: 1000, logger });

    await poller.poll({
      initialResponse: { id: 'resp-3', status: 'in_progress' },
      retrieve: vi.fn(async () => ({
        id: 'resp-3',
        status: 'completed',
        usage,
      })),
      extractId,
      extractStatus,
      providerLabel: 'OpenAI',
      extraFinishData: (response) => ({ usage: response.usage }),
      onFinished: (_response, stats) => {
        finishedStats = stats;
      },
    });

    expect(finishedStats).toMatchObject({
      responseId: 'resp-3',
      status: 'completed',
      pollCount: 1,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('polling finished'),
      expect.objectContaining({
        data: expect.objectContaining({
          responseId: 'resp-3',
          pollCount: 1,
          usage,
        }),
      }),
    );
  });
});
