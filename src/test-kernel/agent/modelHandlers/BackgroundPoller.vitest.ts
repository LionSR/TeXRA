import { afterEach, describe, expect, it, vi } from 'vitest';

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

function trace() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as AgentTrace & {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

const extractId = (response: TestResponse) => response.id;
const extractStatus = (response: TestResponse) => response.status;

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundPoller', () => {
  it('resolves the logger supplier at poll time', async () => {
    const staleLogger = trace();
    const activeLogger = trace();
    let logger = staleLogger;
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 0,
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
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 0,
      maxDurationMs: -1,
      isPending: (response) => response.status === 'in_progress',
      logger,
    });

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
    const logger = trace();
    const retrieve = vi.fn();
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 0,
      maxDurationMs: 3 * 60 * 60 * 1000,
      isPending: (response) => response.status === 'in_progress',
      logger,
    });
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
    vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
    const deadlineAtMs = Date.now() + 1;
    const retrieve = vi.fn(async () => {
      vi.setSystemTime(deadlineAtMs);
      throw new Error('socket hang up');
    });
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 0,
      maxDurationMs: 1000,
      isPending: (response) => response.status === 'in_progress',
      logger: trace(),
    });
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
    vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
    const deadlineAtMs = Date.now() + 1;
    const retrieve = vi.fn(async () => {
      vi.setSystemTime(deadlineAtMs);
      return { id: 'resp-late-result', status: 'completed' };
    });
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 0,
      maxDurationMs: 1000,
      isPending: (response) => response.status === 'in_progress',
      logger: trace(),
    });

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
      vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
      const controller = new AbortController();
      const deadlineAtMs = Date.now() + 1;
      const poller = new BackgroundPoller<TestResponse>({
        pollIntervalMs: 0,
        maxDurationMs: 1000,
        isPending: (response) => response.status === 'in_progress',
        logger: trace(),
      });

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
    vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
    const retrieve = vi.fn(async () => ({
      id: 'resp-boundary',
      status: 'completed',
    }));
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 0,
      maxDurationMs: 0,
      isPending: (response) => response.status === 'in_progress',
      logger: trace(),
    });

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
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 1000,
      maxDurationMs: 10_000,
      isPending: (response) => response.status === 'in_progress',
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
    const poller = new BackgroundPoller<TestResponse>({
      pollIntervalMs: 0,
      maxDurationMs: 1000,
      isPending: (response) => response.status === 'in_progress',
      logger,
    });

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
