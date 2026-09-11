// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import {
  createHelperModelKit,
  runHelperModelCompletion,
  type HelperModelKit,
} from '@agent/runtime/helperModel';

import * as helperModelName from '@agent/runtime/helperModelName';
import * as validationOverride from '@agent/runtime/internalValidationOverride';
import { ModelHandlerValidation } from '@agent/modelHandlers/modelHandlerValidation';
import { runInSession } from '@agent/runtime/RunContext';
import * as modelAvailability from '@model/computeModelOptions';
import * as modelRegistry from '@model/runtimeModelRegistry';
import { createTestSession } from '@test/support/sessionTestUtils';
import { installedHost } from '@test/support/setupPlatform';

function createKit(createResponse: ReturnType<typeof vi.fn>): HelperModelKit {
  return {
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

describe('helper model completion', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('preserves helper output inside a session with document replacement rules', async () => {
    const raw = '<yaml>\nname: correct\ninstruction: $\\mathrm{Tr}$\n</yaml>';
    const postProcessResponse = vi.fn(() => 'document replacement');
    const session = createTestSession({
      responseTextProcessing: {
        normalizeResponseText: (text) => text.trim(),
        postProcessResponse,
        connectResponseText: async () => ' ',
      },
    });
    vi.spyOn(helperModelName, 'getHelperModelName').mockReturnValue('gpt54');
    vi.spyOn(modelAvailability, 'getModelUnavailableReason').mockResolvedValue(
      null,
    );
    vi.spyOn(modelRegistry, 'resolveRuntimeModelConfig').mockResolvedValue(
      MODEL_CONFIGS.gpt54,
    );
    vi.spyOn(
      validationOverride,
      'shouldUseInternalValidationModelHandler',
    ).mockReturnValue(true);
    vi.spyOn(
      ModelHandlerValidation.prototype,
      'createResponse',
    ).mockResolvedValue({
      response: {
        text: raw,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        stopReason: 'STOP',
      },
    });

    try {
      await runInSession(session, async () => {
        const { platform } = installedHost();
        const result = await createHelperModelKit({
          secrets: platform.secrets,
          globalState: platform.globalState,
        });
        if (!result.kit) throw new Error(result.reason);
        await expect(
          runHelperModelCompletion(result.kit, { userPrompt: 'Generate YAML' }),
        ).resolves.toBe(raw);
      });
      expect(postProcessResponse).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
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
