// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  runHelperModelCompletion,
  type HelperModelKit,
} from '@agent/runtime/helperModel';

function createKit(createResponse: ReturnType<typeof vi.fn>): HelperModelKit {
  return {
    modelName: 'openai:test',
    client: {},
    handler: {
      initializeMessages: vi.fn(async () => [
        { role: 'user', content: 'test' },
      ]),
      createResponse,
      extractResponse: vi.fn(() => ({ text: 'recovered' })),
    } as never,
  };
}

describe('helper model completion retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries transient failures twice outside the generation node', async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error('provider unavailable'), {
      status: 503,
    });
    const createResponse = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ response: 'ok' });

    const completion = runHelperModelCompletion(createKit(createResponse), {
      userPrompt: 'test',
    });
    await vi.runAllTimersAsync();

    await expect(completion).resolves.toBe('recovered');
    expect(createResponse).toHaveBeenCalledTimes(3);
  });

  it('does not retry credential failures', async () => {
    const invalid = Object.assign(new Error('invalid credential'), {
      status: 401,
    });
    const createResponse = vi.fn().mockRejectedValue(invalid);

    await expect(
      runHelperModelCompletion(createKit(createResponse), {
        userPrompt: 'test',
      }),
    ).rejects.toBe(invalid);
    expect(createResponse).toHaveBeenCalledOnce();
  });

  it('forwards cancellation to the provider request and retry policy', async () => {
    const controller = new AbortController();
    const createResponse = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        signal?.throwIfAborted();
        return { response: 'unreachable' };
      },
    );

    await expect(
      runHelperModelCompletion(createKit(createResponse), {
        userPrompt: 'test',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createResponse).toHaveBeenCalledOnce();
  });
});
