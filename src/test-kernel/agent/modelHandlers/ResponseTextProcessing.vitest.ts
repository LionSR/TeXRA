// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports
import { ModelHandlerValidation } from '@agent/modelHandlers/modelHandlerValidation';
import { createNeutralResponseTextProcessing } from '@agent/runtime/responseTextProcessing';
import { texraResponseTextProcessing } from '@latex/texraResponseTextProcessing';

const RAW_PROVIDER_TEXT = '$\\mathrm{Tr}$ remains provider text.';
const RESPONSE = {
  text: RAW_PROVIDER_TEXT,
  usage: {
    completion_tokens: 0,
    prompt_tokens: 0,
    total_tokens: 0,
  },
  stopReason: 'stop' as const,
};

describe('response text processing', () => {
  it('returns provider output unchanged when no processor is supplied', () => {
    const handler = new ModelHandlerValidation(MODEL_CONFIGS.gpt54);

    expect(handler.extractResponse(RESPONSE).text).toBe(RAW_PROVIDER_TEXT);
  });

  it('applies an explicitly supplied processor exactly once', () => {
    const postProcessResponse = vi.fn((text: string) => `[${text}]`);
    const handler = new ModelHandlerValidation(
      MODEL_CONFIGS.gpt54,
      postProcessResponse,
    );

    expect(handler.extractResponse(RESPONSE).text).toBe(
      `[${RAW_PROVIDER_TEXT}]`,
    );
    expect(postProcessResponse).toHaveBeenCalledExactlyOnceWith(
      RAW_PROVIDER_TEXT,
    );
  });

  it('joins continuation text deterministically without a helper model', async () => {
    const processing = createNeutralResponseTextProcessing();

    await expect(processing.connectResponseText('left', 'right')).resolves.toBe(
      ' ',
    );
    await expect(
      processing.connectResponseText('left ', 'right'),
    ).resolves.toBe('');
    await expect(processing.connectResponseText('', 'right')).resolves.toBe('');
  });

  it('keeps TeXRA replacement behavior in the application adapter', () => {
    expect(
      texraResponseTextProcessing.postProcessResponse(RAW_PROVIDER_TEXT),
    ).toBe('$\\Tr$ remains provider text.');
  });
});
