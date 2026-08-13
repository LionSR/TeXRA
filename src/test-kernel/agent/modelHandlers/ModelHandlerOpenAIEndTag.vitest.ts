// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerXAI } from '@agent/modelHandlers/openai/modelHandlerXAI';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

const END_TAG = '</document>';

/** A `stop`-configured completion whose text is missing its closing end tag. */
function completionWithoutEndTag() {
  return {
    id: 'test-completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'the document body' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  } as any;
}

describe('ModelHandlerOpenAI.extractResponse end-tag restoration', () => {
  it('restores the end tag for a non-reasoning model that configures a stop sequence', () => {
    // A plain OpenAI chat model sets `stop: [endTag]`, so the SDK strips the
    // matched tag from the completion — extractResponse must put it back.
    const handler = new ModelHandlerOpenAI(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities: { supportsReasoning: false, supportsVision: false },
      }),
    );
    handler.setLogger({ ...noopTrace });

    const result = handler.extractResponse(completionWithoutEndTag(), END_TAG);

    assert.equal(result.text, `the document body\n${END_TAG}`);
  });

  // Reasoning models never configure `stop`, so a natural STOP does not imply
  // the provider stripped the tag — forging it could mask genuinely incomplete
  // output as complete. ModelHandlerXAI inherits the gated behavior via
  // super.extractResponse().
  it.each([
    {
      name: 'an o-series reasoning model',
      build: (): ModelHandlerOpenAI =>
        new ModelHandlerOpenAI(
          buildTestModelConfig({
            provider: ModelProvider.OPENAI,
            capabilities: { supportsReasoning: true, supportsVision: false },
          }),
        ),
    },
    {
      name: 'a Grok reasoning model',
      build: (): ModelHandlerOpenAI =>
        new ModelHandlerXAI(
          buildTestModelConfig({
            provider: ModelProvider.XAI,
            capabilities: { supportsReasoning: true, supportsVision: false },
          }),
        ),
    },
  ])(
    'does not forge an end tag for $name (no stop configured)',
    ({ build }) => {
      const handler = build();
      handler.setLogger({ ...noopTrace });

      const result = handler.extractResponse(
        completionWithoutEndTag(),
        END_TAG,
      );

      assert.equal(result.text, 'the document body');
    },
  );
});
