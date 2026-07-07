// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelCapabilities,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerXAI } from '@agent/modelHandlers/openai/modelHandlerXAI';

const END_TAG = '</document>';

function createLoggerStub(): AgentTrace {
  const noop = () => {
    /* no-op for tests */
  };
  return {
    streamId: 'test-channel',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  } as unknown as AgentTrace;
}

function buildConfig(
  provider: ModelProvider,
  overrides: Partial<Omit<ModelConfig, 'capabilities'>> & {
    capabilities?: Partial<ModelCapabilities>;
  } = {},
): ModelConfig {
  const { capabilities: capabilityOverrides, label, ...rest } = overrides;
  return {
    name: 'test-model',
    fullName: 'test-model',
    shortName: 'test-model',
    provider,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    openRouterOnly: false,
    ...rest,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsVision: false,
      ...(capabilityOverrides ?? {}),
    },
    label: label ?? 'Test Model',
  };
}

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
      buildConfig(ModelProvider.OPENAI, {
        capabilities: { supportsReasoning: false },
      }),
    );
    handler.setLogger(createLoggerStub());

    const result = handler.extractResponse(completionWithoutEndTag(), END_TAG);

    assert.equal(result.text, `the document body\n${END_TAG}`);
  });

  it('does not forge an end tag for an o-series reasoning model (no stop configured)', () => {
    // o-series reasoning models never configure `stop`, so a natural STOP does
    // not imply the provider stripped the tag — forging it could mask
    // genuinely incomplete output as complete.
    const handler = new ModelHandlerOpenAI(
      buildConfig(ModelProvider.OPENAI, {
        capabilities: { supportsReasoning: true },
      }),
    );
    handler.setLogger(createLoggerStub());

    const result = handler.extractResponse(completionWithoutEndTag(), END_TAG);

    assert.equal(result.text, 'the document body');
  });

  it('does not forge an end tag for a Grok reasoning model (no stop configured)', () => {
    // ModelHandlerXAI inherits the gated behavior via super.extractResponse().
    const handler = new ModelHandlerXAI(
      buildConfig(ModelProvider.XAI, {
        capabilities: { supportsReasoning: true },
      }),
    );
    handler.setLogger(createLoggerStub());

    const result = handler.extractResponse(completionWithoutEndTag(), END_TAG);

    assert.equal(result.text, 'the document body');
  });
});
