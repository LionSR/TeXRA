// Third-party imports
import { describe, it, expect } from 'vitest';
import { ReasoningEffort } from 'llm-zoo';

// Local imports - functions under test
import {
  buildThinkingConfig,
  isCompactionEligibleModel,
  mapAnthropicEffort,
  requiresNoTemperatureWithThinking,
  supportsAdaptiveThinking,
} from '@agent/modelHandlers/anthropic/anthropicThinking';

const OPUS_46 = 'claude-opus-4-6';
const OPUS_47 = 'claude-opus-4-7';
const OPUS_48 = 'claude-opus-4-8';
const OPUS_5 = 'claude-opus-5';
const SONNET_46 = 'claude-sonnet-4-6';
const SONNET_5 = 'claude-sonnet-5';
const FABLE_5 = 'claude-fable-5';
const MYTHOS_5 = 'claude-mythos-5';
const SONNET_35 = 'claude-3-5-sonnet-20241022';

describe('mapAnthropicEffort', () => {
  it('defaults to the API default "high" when no effort is configured', () => {
    expect(mapAnthropicEffort(OPUS_48, null)).toBe('high');
  });

  it('maps the internal "max" tier on Opus models and caps others at "high"', () => {
    expect(mapAnthropicEffort(OPUS_46, ReasoningEffort.MAX)).toBe('max');
    expect(mapAnthropicEffort(OPUS_47, ReasoningEffort.MAX)).toBe('max');
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.MAX)).toBe('max');
    expect(mapAnthropicEffort(OPUS_5, ReasoningEffort.MAX)).toBe('max');
    // Sonnet 5 accepts the top "max" tier like Opus.
    expect(mapAnthropicEffort(SONNET_5, ReasoningEffort.MAX)).toBe('max');
    // Sonnet 4.6 and older non-Opus models cap at "high".
    expect(mapAnthropicEffort(SONNET_46, ReasoningEffort.MAX)).toBe('high');
    expect(mapAnthropicEffort(SONNET_35, ReasoningEffort.MAX)).toBe('high');
  });

  it('maps "max" on Mythos-class models', () => {
    expect(mapAnthropicEffort(FABLE_5, ReasoningEffort.MAX)).toBe('max');
    expect(mapAnthropicEffort(MYTHOS_5, ReasoningEffort.MAX)).toBe('max');
  });

  it('maps "xhigh" to the distinct tier on Opus 4.8/5, Sonnet 5, and Mythos-class models', () => {
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.XHIGH)).toBe('xhigh');
    expect(mapAnthropicEffort(OPUS_5, ReasoningEffort.XHIGH)).toBe('xhigh');
    expect(mapAnthropicEffort(SONNET_5, ReasoningEffort.XHIGH)).toBe('xhigh');
    expect(mapAnthropicEffort(FABLE_5, ReasoningEffort.XHIGH)).toBe('xhigh');
    expect(mapAnthropicEffort(MYTHOS_5, ReasoningEffort.XHIGH)).toBe('xhigh');
    // Opus 4.6/4.7 predate the tier split and collapse "xhigh" to "max".
    expect(mapAnthropicEffort(OPUS_46, ReasoningEffort.XHIGH)).toBe('max');
    expect(mapAnthropicEffort(OPUS_47, ReasoningEffort.XHIGH)).toBe('max');
    // Sonnet 4.6 and older non-Opus models cap at "high".
    expect(mapAnthropicEffort(SONNET_46, ReasoningEffort.XHIGH)).toBe('high');
  });

  it('passes through high/medium and floors low/none at "low"', () => {
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.HIGH)).toBe('high');
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.MEDIUM)).toBe('medium');
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.LOW)).toBe('low');
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.NONE)).toBe('low');
  });
});

describe('supportsAdaptiveThinking / isCompactionEligibleModel', () => {
  it('is true for Opus 4.6/4.7/4.8/5, Sonnet 4.6, Sonnet 5, and Mythos-class models', () => {
    for (const model of [
      OPUS_46,
      OPUS_47,
      OPUS_48,
      OPUS_5,
      SONNET_46,
      SONNET_5,
      FABLE_5,
      MYTHOS_5,
    ]) {
      expect(supportsAdaptiveThinking(model)).toBe(true);
      expect(isCompactionEligibleModel(model)).toBe(true);
    }
  });

  it('is false for older Claude models', () => {
    expect(supportsAdaptiveThinking(SONNET_35)).toBe(false);
    expect(isCompactionEligibleModel(SONNET_35)).toBe(false);
  });
});

// The per-family traits above are driven by one prefix-keyed table. Pin the
// full effort cross-product so a new row (or a reordered prefix) can't shift
// an existing family's ceiling unnoticed — the drift mode the table replaced.
describe('effort ceilings across every known family', () => {
  const EXPECTED_CEILINGS: ReadonlyArray<
    readonly [model: string, onMax: string, onXhigh: string]
  > = [
    [OPUS_46, 'max', 'max'],
    [OPUS_47, 'max', 'max'],
    [OPUS_48, 'max', 'xhigh'],
    [OPUS_5, 'max', 'xhigh'],
    [SONNET_46, 'high', 'high'],
    [SONNET_5, 'max', 'xhigh'],
    [FABLE_5, 'max', 'xhigh'],
    [MYTHOS_5, 'max', 'xhigh'],
    [SONNET_35, 'high', 'high'],
  ];

  it.each(EXPECTED_CEILINGS)(
    '%s maps max -> %s and xhigh -> %s',
    (model, onMax, onXhigh) => {
      expect(mapAnthropicEffort(model, ReasoningEffort.MAX)).toBe(onMax);
      expect(mapAnthropicEffort(model, ReasoningEffort.XHIGH)).toBe(onXhigh);
    },
  );

  it('matches a versioned model id the same way as its bare family prefix', () => {
    expect(
      mapAnthropicEffort(`${OPUS_48}-20260115`, ReasoningEffort.XHIGH),
    ).toBe('xhigh');
    expect(supportsAdaptiveThinking(`${SONNET_5}-20260115`)).toBe(true);
  });
});

describe('requiresNoTemperatureWithThinking', () => {
  it('is true for all Claude 4 families, Opus 5, Sonnet 5, and Mythos-class models', () => {
    expect(requiresNoTemperatureWithThinking(OPUS_48)).toBe(true);
    expect(requiresNoTemperatureWithThinking(OPUS_5)).toBe(true);
    expect(requiresNoTemperatureWithThinking(SONNET_46)).toBe(true);
    expect(requiresNoTemperatureWithThinking(SONNET_5)).toBe(true);
    expect(requiresNoTemperatureWithThinking('claude-haiku-4-5')).toBe(true);
    expect(requiresNoTemperatureWithThinking(FABLE_5)).toBe(true);
    expect(requiresNoTemperatureWithThinking(MYTHOS_5)).toBe(true);
  });

  it('is false for Claude 3.x models', () => {
    expect(requiresNoTemperatureWithThinking(SONNET_35)).toBe(false);
  });
});

describe('buildThinkingConfig', () => {
  it('uses adaptive thinking with summarized display and top effort tiers on Opus 5', () => {
    for (const [reasoningEffort, effort] of [
      [ReasoningEffort.XHIGH, 'xhigh'],
      [ReasoningEffort.MAX, 'max'],
    ] as const) {
      const config = buildThinkingConfig({
        fullName: OPUS_5,
        reasoningEffort,
        maxTokens: 128000,
        useStreaming: true,
      });
      expect(config.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
      expect(config.outputConfig).toEqual({ effort });
      expect(config.removeTemperature).toBe(true);
    }
  });

  it('uses adaptive thinking with summarized display on Opus 4.7+', () => {
    const config = buildThinkingConfig({
      fullName: OPUS_48,
      reasoningEffort: ReasoningEffort.HIGH,
      maxTokens: 64000,
      useStreaming: true,
    });
    expect(config.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(config.outputConfig).toEqual({ effort: 'high' });
    expect(config.removeTemperature).toBe(true);
  });

  it('uses adaptive thinking with summarized display on Mythos-class models', () => {
    for (const model of [FABLE_5, MYTHOS_5]) {
      const config = buildThinkingConfig({
        fullName: model,
        reasoningEffort: ReasoningEffort.XHIGH,
        maxTokens: 64000,
        useStreaming: true,
      });
      expect(config.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
      expect(config.outputConfig).toEqual({ effort: 'xhigh' });
      expect(config.removeTemperature).toBe(true);
    }
  });

  it('uses adaptive thinking with summarized display on Sonnet 5, accepting the top effort tiers', () => {
    const config = buildThinkingConfig({
      fullName: SONNET_5,
      reasoningEffort: ReasoningEffort.MAX,
      maxTokens: 64000,
      useStreaming: true,
    });
    expect(config.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    // Sonnet 5 accepts the full effort range, including the top "max" tier.
    expect(config.outputConfig).toEqual({ effort: 'max' });
    // Sonnet 5 rejects sampling parameters, so temperature must be removed.
    expect(config.removeTemperature).toBe(true);
  });

  it('uses bare adaptive thinking on earlier adaptive models', () => {
    const config = buildThinkingConfig({
      fullName: SONNET_46,
      reasoningEffort: ReasoningEffort.MEDIUM,
      maxTokens: 64000,
      useStreaming: false,
    });
    expect(config.thinking).toEqual({ type: 'adaptive' });
    expect(config.outputConfig).toEqual({ effort: 'medium' });
  });

  it('falls back to a manual budget for non-adaptive models', () => {
    // Streaming uses the larger default budget, capped at half of max_tokens.
    const streaming = buildThinkingConfig({
      fullName: SONNET_35,
      reasoningEffort: null,
      maxTokens: 100000,
      useStreaming: true,
    });
    expect(streaming.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 32768,
    });

    // Non-streaming uses the smaller default budget.
    const nonStreaming = buildThinkingConfig({
      fullName: SONNET_35,
      reasoningEffort: null,
      maxTokens: 100000,
      useStreaming: false,
    });
    expect(nonStreaming.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    });

    // The budget never exceeds half of max_tokens.
    const capped = buildThinkingConfig({
      fullName: SONNET_35,
      reasoningEffort: null,
      maxTokens: 8000,
      useStreaming: true,
    });
    expect(capped.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
  });
});
