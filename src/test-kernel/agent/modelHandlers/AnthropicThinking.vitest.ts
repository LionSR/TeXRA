// Third-party imports
import { MODEL_CONFIGS, ReasoningEffort, type ModelConfig } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports - functions under test
import {
  buildThinkingConfig,
  isCompactionEligibleModel,
  normalizeAnthropicEffort,
  requiresNoTemperatureWithThinking,
} from '@agent/modelHandlers/anthropic/anthropicThinking';

const SONNET_35 = 'claude-3-5-sonnet-20241022';

type AdaptiveFixture = readonly [
  model: ModelConfig,
  accepted: readonly ReasoningEffort[],
  onXhigh: 'xhigh' | 'max',
];

const ADAPTIVE_MODELS: readonly AdaptiveFixture[] = [
  [
    MODEL_CONFIGS.opus46T,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.MAX,
    ],
    'max',
  ],
  [
    MODEL_CONFIGS.opus47T,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.XHIGH,
      ReasoningEffort.MAX,
    ],
    'xhigh',
  ],
  [
    MODEL_CONFIGS.opus48T,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.XHIGH,
      ReasoningEffort.MAX,
    ],
    'xhigh',
  ],
  [
    MODEL_CONFIGS.opus5T,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.XHIGH,
      ReasoningEffort.MAX,
    ],
    'xhigh',
  ],
  [
    MODEL_CONFIGS.sonnet46T,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.MAX,
    ],
    'max',
  ],
  [
    MODEL_CONFIGS.sonnet5T,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.XHIGH,
      ReasoningEffort.MAX,
    ],
    'xhigh',
  ],
  [
    MODEL_CONFIGS.fable5,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.XHIGH,
      ReasoningEffort.MAX,
    ],
    'xhigh',
  ],
  [
    MODEL_CONFIGS.mythos5,
    [
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
      ReasoningEffort.XHIGH,
      ReasoningEffort.MAX,
    ],
    'xhigh',
  ],
];

function thinkingConfig(
  model: ModelConfig,
  reasoningEffort: ReasoningEffort | null,
) {
  return buildThinkingConfig({
    fullName: model.fullName,
    capabilities: model.capabilities,
    reasoningEffort,
    maxTokens: 128000,
    useStreaming: true,
  });
}

describe('normalizeAnthropicEffort', () => {
  it.each(ADAPTIVE_MODELS)(
    '$0.name uses the exact official vocabulary and accepts max',
    (model, accepted, onXhigh) => {
      expect(model.capabilities.supportsAdaptiveThinking).toBe(true);
      expect(model.capabilities.supportedReasoningEfforts).toEqual(accepted);
      expect(
        normalizeAnthropicEffort(
          model.capabilities.supportedReasoningEfforts,
          ReasoningEffort.MAX,
        ),
      ).toBe('max');
      expect(
        normalizeAnthropicEffort(
          model.capabilities.supportedReasoningEfforts,
          ReasoningEffort.XHIGH,
        ),
      ).toBe(onXhigh);
    },
  );

  it('preserves low/medium/high and floors none at low', () => {
    const accepted =
      MODEL_CONFIGS.opus5T.capabilities.supportedReasoningEfforts;
    expect(normalizeAnthropicEffort(accepted, ReasoningEffort.HIGH)).toBe(
      'high',
    );
    expect(normalizeAnthropicEffort(accepted, ReasoningEffort.MEDIUM)).toBe(
      'medium',
    );
    expect(normalizeAnthropicEffort(accepted, ReasoningEffort.LOW)).toBe('low');
    expect(normalizeAnthropicEffort(accepted, ReasoningEffort.NONE)).toBe(
      'low',
    );
    expect(normalizeAnthropicEffort(accepted, null)).toBe('high');
  });

  it('keeps the capped legacy fallback for entries without a vocabulary', () => {
    expect(normalizeAnthropicEffort(undefined, ReasoningEffort.LOW)).toBe(
      'low',
    );
    expect(normalizeAnthropicEffort(undefined, ReasoningEffort.MEDIUM)).toBe(
      'medium',
    );
    expect(normalizeAnthropicEffort(undefined, ReasoningEffort.HIGH)).toBe(
      'high',
    );
    expect(normalizeAnthropicEffort(undefined, ReasoningEffort.XHIGH)).toBe(
      'high',
    );
    expect(normalizeAnthropicEffort(undefined, ReasoningEffort.MAX)).toBe(
      'high',
    );
  });

  it('caps the non-thinking Opus 5 entry at high', () => {
    const capabilities = MODEL_CONFIGS.opus5.capabilities;
    expect(capabilities.supportsAdaptiveThinking).toBe(false);
    expect(capabilities.supportedReasoningEfforts).toEqual([
      ReasoningEffort.LOW,
      ReasoningEffort.MEDIUM,
      ReasoningEffort.HIGH,
    ]);
    expect(
      normalizeAnthropicEffort(
        capabilities.supportedReasoningEfforts,
        ReasoningEffort.MAX,
      ),
    ).toBe('high');
  });
});

describe('local Anthropic request traits', () => {
  it('keeps compaction eligibility for the eight adaptive families', () => {
    for (const [model] of ADAPTIVE_MODELS) {
      expect(isCompactionEligibleModel(model.fullName)).toBe(true);
    }
    expect(isCompactionEligibleModel(SONNET_35)).toBe(false);
  });

  it('removes temperature for Claude 4/5 thinking families', () => {
    for (const model of [
      MODEL_CONFIGS.opus48T,
      MODEL_CONFIGS.opus5T,
      MODEL_CONFIGS.sonnet46T,
      MODEL_CONFIGS.sonnet5T,
      MODEL_CONFIGS.fable5,
      MODEL_CONFIGS.mythos5,
    ]) {
      expect(requiresNoTemperatureWithThinking(model.fullName)).toBe(true);
    }
    expect(requiresNoTemperatureWithThinking(SONNET_35)).toBe(false);
  });
});

describe('buildThinkingConfig', () => {
  it.each(ADAPTIVE_MODELS)(
    '$0.name builds adaptive thinking with its normalized xhigh effort',
    (model, _accepted, onXhigh) => {
      const config = thinkingConfig(model, ReasoningEffort.XHIGH);
      expect(config.thinking).toEqual(
        model === MODEL_CONFIGS.opus46T || model === MODEL_CONFIGS.sonnet46T
          ? { type: 'adaptive' }
          : { type: 'adaptive', display: 'summarized' },
      );
      expect(config.outputConfig).toEqual({ effort: onXhigh });
      expect(config.removeTemperature).toBe(true);
    },
  );

  it.each([
    [MODEL_CONFIGS.opus5, MODEL_CONFIGS.opus5T],
    [MODEL_CONFIGS.opus47, MODEL_CONFIGS.opus47T],
  ])(
    'uses paired entry capabilities, not their shared fullName, for request shape',
    (base, thinking) => {
      expect(base.fullName).toBe(thinking.fullName);
      expect(base.capabilities.supportsAdaptiveThinking).toBe(false);
      expect(thinking.capabilities.supportsAdaptiveThinking).toBe(true);

      expect(thinkingConfig(base, ReasoningEffort.HIGH).thinking).toEqual({
        type: 'enabled',
        budget_tokens: 32768,
      });
      expect(thinkingConfig(thinking, ReasoningEffort.HIGH).thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
    },
  );

  it('falls back to bounded manual budgets for non-adaptive entries', () => {
    const capabilities = MODEL_CONFIGS.sonnet36.capabilities;
    const streaming = buildThinkingConfig({
      fullName: SONNET_35,
      capabilities,
      reasoningEffort: null,
      maxTokens: 100000,
      useStreaming: true,
    });
    expect(streaming.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 32768,
    });

    const nonStreaming = buildThinkingConfig({
      fullName: SONNET_35,
      capabilities,
      reasoningEffort: null,
      maxTokens: 100000,
      useStreaming: false,
    });
    expect(nonStreaming.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    });

    const capped = buildThinkingConfig({
      fullName: SONNET_35,
      capabilities,
      reasoningEffort: null,
      maxTokens: 8000,
      useStreaming: true,
    });
    expect(capped.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
  });
});
