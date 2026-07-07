import { describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { BackgroundRunLifecycle } from '@agent/modelHandlers/openai/BackgroundRunLifecycle';
import { BackgroundPoller } from '@agent/modelHandlers/support/BackgroundPoller';

import type OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';

function trace(): AgentTrace {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    domain: vi.fn(),
  } as unknown as AgentTrace;
}

function createLifecycle(logger: AgentTrace = trace()): BackgroundRunLifecycle {
  return new BackgroundRunLifecycle({
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

describe('BackgroundRunLifecycle.isPending / pending-id bookkeeping', () => {
  it('treats queued and in_progress as pending, everything else as terminal', () => {
    const lifecycle = createLifecycle();

    expect(lifecycle.isPending({ status: 'queued' } as Response)).toBe(true);
    expect(lifecycle.isPending({ status: 'in_progress' } as Response)).toBe(
      true,
    );
    expect(lifecycle.isPending({ status: 'completed' } as Response)).toBe(
      false,
    );
    expect(lifecycle.isPending({ status: 'failed' } as Response)).toBe(false);
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

    // Simulate a prior poll having remembered a pending id.
    (lifecycle as unknown as { pendingResponseId: string }).pendingResponseId =
      'resp-done';

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
    (lifecycle as unknown as { pendingResponseId: string }).pendingResponseId =
      'resp-failed';

    const result = await lifecycle.tryResume(client);

    expect(result).toBeNull();
    expect(lifecycle.hasPendingResume()).toBe(false);
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
    const lifecycle = createLifecycle();
    // Swap in a fast poller so the test doesn't wait on the real 15s interval.
    (
      lifecycle as unknown as { backgroundPoller: BackgroundPoller<Response> }
    ).backgroundPoller = new BackgroundPoller({
      pollIntervalMs: 0,
      maxDurationMs: 1000,
      isPending: (r) => lifecycle.isPending(r),
      logger: trace(),
    });
    const client = {
      responses: {
        retrieve: vi.fn(async () => ({
          id: 'resp-terminal',
          status: 'failed',
          error: { message: 'server error' },
        })),
      },
    } as unknown as OpenAI;

    await expect(
      lifecycle.waitForCompletion(client, {
        id: 'resp-terminal',
        status: 'in_progress',
      } as Response),
    ).rejects.toThrow();
  });
});
