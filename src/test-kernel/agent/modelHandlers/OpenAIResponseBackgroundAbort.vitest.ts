// Third-party imports
import { APIUserAbortError } from 'openai';
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { tagOpenAISdkError } from '@agent/modelHandlers/openai/openAISdkError';
import { BackgroundPoller } from '@agent/modelHandlers/support/BackgroundPoller';
import { isUserAbort } from '@common/errors/sdkErrorUtils';

// Third-party imports
import type OpenAI from 'openai';

function createHandler(): ModelHandlerOpenAIResponse {
  const handler = new ModelHandlerOpenAIResponse({
    name: 'test-gpt',
    label: 'Test GPT',
    fullName: 'gpt-test',
    shortName: 'gpt-test',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  });
  handler.setLogger({
    streamId: 'test',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    domain: vi.fn(),
  } as unknown as AgentTrace);
  return handler;
}

type BackgroundLifecycleInternals = {
  backgroundPoller: BackgroundPoller<{
    id?: string;
    status?: string | null;
  }>;
  pendingResponseId: string | null;
  tryResume(client: OpenAI, signal?: AbortSignal): Promise<unknown>;
  waitForCompletion(
    client: OpenAI,
    initialResponse: { id?: string; status?: string | null },
    signal?: AbortSignal,
  ): Promise<unknown>;
};

function internals(
  handler: ModelHandlerOpenAIResponse,
): BackgroundLifecycleInternals {
  return (
    handler as unknown as { backgroundLifecycle: BackgroundLifecycleInternals }
  ).backgroundLifecycle;
}

function createRetrieveThrowingClient(error: unknown): OpenAI {
  return {
    responses: {
      retrieve: vi.fn(async () => {
        throw error;
      }),
    },
  } as unknown as OpenAI;
}

describe('OpenAI Responses background abort handling', () => {
  // Pins the SDK contract the abort path depends on: openai throws its own
  // APIUserAbortError (NOT a DOMException) when the signal fires inside
  // retrieve(). If an SDK upgrade changes this, the abort path must be
  // re-verified.
  it('recognizes the SDK abort class via isUserAbort once tagged', () => {
    const err = new APIUserAbortError();
    expect(err instanceof DOMException).toBe(false);
    tagOpenAISdkError(err, 'openai');
    expect(isUserAbort(err)).toBe(true);
  });

  it('recognizes plain AbortController DOMExceptions (delay path)', () => {
    const err = new DOMException('This operation was aborted', 'AbortError');
    expect(isUserAbort(err)).toBe(true);
  });

  it('clears the pending background ID on abort during resume retrieve', async () => {
    const handler = createHandler();
    const target = internals(handler);
    target.pendingResponseId = 'resp_pending_abort';

    const abortError = new APIUserAbortError();
    const client = createRetrieveThrowingClient(abortError);

    await expect(target.tryResume(client)).rejects.toThrow(APIUserAbortError);

    // Ghost-resume regression (#error-pipeline T1-1): an aborted resume must
    // not retain the pending ID, or the next run silently resumes a response
    // the user cancelled.
    expect(target.pendingResponseId).toBeNull();
  });

  it('retains the pending background ID on transient retrieve failures', async () => {
    const handler = createHandler();
    const target = internals(handler);
    target.pendingResponseId = 'resp_pending_transient';

    const transient = new Error('socket hang up');
    const client = createRetrieveThrowingClient(transient);

    await expect(target.tryResume(client)).rejects.toThrow('socket hang up');

    // No status code → likely still alive server-side → keep the ID so the
    // outer retry resumes the same response.
    expect(target.pendingResponseId).toBe('resp_pending_transient');
  });

  it('surfaces background polling timeouts', async () => {
    const handler = createHandler();
    const target = internals(handler);
    target.backgroundPoller = new BackgroundPoller({
      pollIntervalMs: 1,
      maxDurationMs: 0,
      isPending: (response) => response.status === 'in_progress',
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        domain: vi.fn(),
      } as unknown as AgentTrace,
    });

    const thrown = await target
      .waitForCompletion(
        { responses: { retrieve: vi.fn() } } as unknown as OpenAI,
        { id: 'resp_timeout', status: 'in_progress' },
      )
      .catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
  });
});
