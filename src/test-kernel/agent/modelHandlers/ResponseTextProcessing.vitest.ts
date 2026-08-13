// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerValidation } from '@agent/modelHandlers/modelHandlerValidation';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { createNeutralResponseTextProcessing } from '@agent/runtime/responseTextProcessing';
import { texraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

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
    const handler = new ModelHandlerValidation(MODEL_CONFIGS.gpt54, {
      normalizeResponseText: (text) => text,
      postProcessResponse,
      connectResponseText: async () => ' ',
    });

    expect(handler.extractResponse(RESPONSE).text).toBe(
      `[${RAW_PROVIDER_TEXT}]`,
    );
    expect(postProcessResponse).toHaveBeenCalledExactlyOnceWith(
      RAW_PROVIDER_TEXT,
    );
  });

  it('preserves OpenAI Chat Completions whitespace by default', () => {
    const handler = new ModelHandlerOpenAI(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities: { supportsReasoning: true, supportsVision: false },
      }),
    );
    handler.setLogger({ ...noopTrace });

    const result = handler.extractResponse(
      {
        choices: [
          {
            message: { content: '  indented text\n' },
            finish_reason: 'stop',
          },
        ],
      },
      '',
    );

    expect(result.text).toBe('  indented text\n');
  });

  it.each([
    { left: 'left', right: 'right', expected: ' ' },
    { left: 'left ', right: 'right', expected: '' },
    { left: '', right: 'right', expected: '' },
  ])(
    'joins continuation text deterministically without a helper model ($left + $right)',
    async ({ left, right, expected }) => {
      const processing = createNeutralResponseTextProcessing();

      await expect(processing.connectResponseText(left, right)).resolves.toBe(
        expected,
      );
    },
  );

  it('keeps TeXRA replacement behavior in the application adapter', () => {
    expect(Object.isFrozen(texraResponseTextProcessing)).toBe(true);

    const normalized = texraResponseTextProcessing.normalizeResponseText(
      ` ${RAW_PROVIDER_TEXT}\n`,
    );
    expect(texraResponseTextProcessing.postProcessResponse(normalized)).toBe(
      '$\\Tr$ remains provider text.',
    );
  });
});
