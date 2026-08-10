import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { createOpenAIBackgroundRunLifecycle } from '@agent/modelHandlers/openai/openAIBackgroundRunLifecycle';
import type { BackgroundRunLifecycle } from '@agent/modelHandlers/support/BackgroundRunLifecycle';
import {
  isProviderErrorAutoRetryable,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import { spiedTrace } from '@test/support/spiedTrace';

import type OpenAI from 'openai';
import type {
  Response,
  ResponseRetrieveParamsNonStreaming,
} from 'openai/resources/responses/responses';

function createLifecycle(
  logger: AgentTrace = spiedTrace(),
): BackgroundRunLifecycle<
  OpenAI,
  Response,
  ResponseRetrieveParamsNonStreaming
> {
  return createOpenAIBackgroundRunLifecycle({
    logger: () => logger,
    provider: 'openai',
  });
}

function completedResponse(id: string): Response {
  return {
    id,
    status: 'completed',
    output: [],
    output_text: 'ok',
  } as unknown as Response;
}

/** Assert a poll rejects with the max-duration timeout and its error metadata. */
async function expectPollingTimeout(promise: Promise<unknown>): Promise<void> {
  const timeout = await promise.catch((error: unknown) => error);
  expect(timeout).toBeInstanceOf(Error);
  expect((timeout as Error).message).toContain(
    'exceeded maximum polling duration',
  );
  expect(normalizeProviderError(timeout).userRetryable).toBe(true);
  expect(isProviderErrorAutoRetryable(timeout)).toBe(false);
}

const MAX_BACKGROUND_DURATION_MS = 3 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundRunLifecycle.isPending / pending-id bookkeeping', () => {
  it.each([
    { status: 'queued', pending: true },
    { status: 'in_progress', pending: true },
    { status: 'completed', pending: false },
    { status: 'failed', pending: false },
  ])('treats $status as pending=$pending', ({ status, pending }) => {
    const lifecycle = createLifecycle();

    expect(lifecycle.isPending({ status } as Response)).toBe(pending);
  });

  it('reports no pending resume until a poll remembers one', () => {
    const lifecycle = createLifecycle();

    expect(lifecycle.hasPendingResume()).toBe(false);
    expect(lifecycle.getPendingId()).toBeNull();
  });

  it('clearPending resets both the id and retrieve params', async () => {
    const lifecycle = createLifecycle();
    const client = {
      responses: { retrieve: vi.fn(async () => completedResponse('resp-1')) },
    } as unknown as OpenAI;

    await lifecycle.waitForCompletion(client, {
      id: 'resp-1',
      status: 'completed',
    } as Response);
    // waitForCompletion always remembers the id as pending first (so a
    // connection failure mid-poll can resume) — clearing it is the caller's
    // job (the handler's finalizeResponse()), not waitForCompletion's.
    expect(lifecycle.hasPendingResume()).toBe(true);

    lifecycle.clearPending();
    expect(lifecycle.hasPendingResume()).toBe(false);
    expect(lifecycle.getPendingId()).toBeNull();
  });
});

describe('BackgroundRunLifecycle.tryResume', () => {
  it('returns null when nothing is pending', async () => {
    const lifecycle = createLifecycle();
    const client = { responses: { retrieve: vi.fn() } } as unknown as OpenAI;

    await expect(lifecycle.tryResume(client)).resolves.toBeNull();
    expect(client.responses.retrieve).not.toHaveBeenCalled();
  });

  it('resolves with the retrieved response once it is already completed', async () => {
    const lifecycle = createLifecycle();
    const client = {
      responses: {
        retrieve: vi.fn(async () => completedResponse('resp-done')),
      },
    } as unknown as OpenAI;

    // A prior poll remembers the id as pending through the public path.
    await lifecycle.retrieveAndRemember(
      client,
      'resp-done',
      undefined,
      undefined,
    );
    vi.mocked(client.responses.retrieve).mockClear();

    const result = await lifecycle.tryResume(client);

    expect(result?.id).toBe('resp-done');
    expect(client.responses.retrieve).toHaveBeenCalledWith(
      'resp-done',
      undefined,
      undefined,
    );
  });

  it('clears the pending id and returns null when the response failed remotely', async () => {
    const lifecycle = createLifecycle();
    const client = {
      responses: {
        retrieve: vi.fn(async () => ({
          id: 'resp-failed',
          status: 'failed',
          error: { message: 'boom' },
        })),
      },
    } as unknown as OpenAI;
    await lifecycle.retrieveAndRemember(
      client,
      'resp-failed',
      undefined,
      undefined,
    );

    const result = await lifecycle.tryResume(client);

    expect(result).toBeNull();
    expect(lifecycle.hasPendingResume()).toBe(false);
  });

  it('does not restart the polling lifetime when the same response resumes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
    const lifecycle = createLifecycle();
    const retrieve = vi.fn(async () => ({
      id: 'resp-pending',
      status: 'in_progress',
    }));
    const client = { responses: { retrieve } } as unknown as OpenAI;

    await lifecycle.retrieveAndRemember(
      client,
      'resp-pending',
      undefined,
      undefined,
    );
    retrieve.mockClear();
    vi.advanceTimersByTime(MAX_BACKGROUND_DURATION_MS);

    await expectPollingTimeout(lifecycle.tryResume(client));
    expect(retrieve).not.toHaveBeenCalled();
    expect(lifecycle.getPendingId()).toBeNull();
  });
});

describe('BackgroundRunLifecycle.retrieveAndRemember', () => {
  it('remembers the id as pending before retrieving', async () => {
    const lifecycle = createLifecycle();
    let pendingDuringRetrieve: string | null = null;
    const client = {
      responses: {
        retrieve: vi.fn(async () => {
          pendingDuringRetrieve = lifecycle.getPendingId();
          return completedResponse('resp-recovered');
        }),
      },
    } as unknown as OpenAI;

    const result = await lifecycle.retrieveAndRemember(
      client,
      'resp-recovered',
      undefined,
      undefined,
    );

    expect(pendingDuringRetrieve).toBe('resp-recovered');
    expect(result.id).toBe('resp-recovered');
  });

  it('rethrows and clears pending on a non-retryable retrieve failure', async () => {
    const lifecycle = createLifecycle();
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    const client = {
      responses: {
        retrieve: vi.fn(async () => {
          throw notFound;
        }),
      },
    } as unknown as OpenAI;

    await expect(
      lifecycle.retrieveAndRemember(client, 'resp-x', undefined, undefined),
    ).rejects.toThrow('not found');
    expect(lifecycle.hasPendingResume()).toBe(false);
  });

  it('replaces a transient failure with the timeout when retrieval settles late', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-01T00:00:00.000Z') });
    const lifecycle = createLifecycle();
    const retrieve = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 2);
        throw new Error('socket hang up');
      });
    const client = { responses: { retrieve } } as unknown as OpenAI;

    await expect(
      lifecycle.retrieveAndRemember(client, 'resp-late', undefined, undefined),
    ).rejects.toThrow('socket hang up');
    vi.advanceTimersByTime(MAX_BACKGROUND_DURATION_MS - 1);

    await expectPollingTimeout(lifecycle.tryResume(client));
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(lifecycle.hasPendingResume()).toBe(false);
  });
});

describe('BackgroundRunLifecycle.waitForCompletion', () => {
  it('returns the initial response unchanged when it has no id', async () => {
    const lifecycle = createLifecycle();
    const client = { responses: { retrieve: vi.fn() } } as unknown as OpenAI;
    const response = { status: 'completed' } as Response;

    const result = await lifecycle.waitForCompletion(client, response);

    expect(result).toBe(response);
    expect(client.responses.retrieve).not.toHaveBeenCalled();
  });

  it('throws a terminal error when polling ends in a non-completed status', async () => {
    // Fake timers carry the test past the real poll interval deterministically
    // instead of swapping in a fast poller through the private field.
    vi.useFakeTimers();
    const lifecycle = createLifecycle();
    const client = {
      responses: {
        retrieve: vi.fn(async () => ({
          id: 'resp-terminal',
          status: 'failed',
          error: { message: 'server error' },
        })),
      },
    } as unknown as OpenAI;

    const completion = lifecycle.waitForCompletion(client, {
      id: 'resp-terminal',
      status: 'in_progress',
    } as Response);
    const rejection = expect(completion).rejects.toThrow();
    // One step well past the first poll interval, far short of the deadline.
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(lifecycle.hasPendingResume()).toBe(false);
  });
});
