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
const SONNET_46 = 'claude-sonnet-4-6';
const SONNET_35 = 'claude-3-5-sonnet-20241022';

describe('mapAnthropicEffort', () => {
  it('defaults to the API default "high" when no effort is configured', () => {
    expect(mapAnthropicEffort(OPUS_48, null)).toBe('high');
  });

  it('maps the internal "max" tier only on Opus models', () => {
    expect(mapAnthropicEffort(OPUS_46, ReasoningEffort.MAX)).toBe('max');
    expect(mapAnthropicEffort(OPUS_47, ReasoningEffort.MAX)).toBe('max');
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.MAX)).toBe('max');
    // Non-Opus models cap at "high".
    expect(mapAnthropicEffort(SONNET_46, ReasoningEffort.MAX)).toBe('high');
    expect(mapAnthropicEffort(SONNET_35, ReasoningEffort.MAX)).toBe('high');
  });

  it('maps "xhigh" to the distinct tier only on Opus 4.8', () => {
    expect(mapAnthropicEffort(OPUS_48, ReasoningEffort.XHIGH)).toBe('xhigh');
    // Opus 4.6/4.7 predate the tier split and collapse "xhigh" to "max".
    expect(mapAnthropicEffort(OPUS_46, ReasoningEffort.XHIGH)).toBe('max');
    expect(mapAnthropicEffort(OPUS_47, ReasoningEffort.XHIGH)).toBe('max');
    // Everything else caps at "high".
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
  it('is true for Opus 4.6/4.7/4.8 and Sonnet 4.6', () => {
    for (const model of [OPUS_46, OPUS_47, OPUS_48, SONNET_46]) {
      expect(supportsAdaptiveThinking(model)).toBe(true);
      expect(isCompactionEligibleModel(model)).toBe(true);
    }
  });

  it('is false for older Claude models', () => {
    expect(supportsAdaptiveThinking(SONNET_35)).toBe(false);
    expect(isCompactionEligibleModel(SONNET_35)).toBe(false);
  });
});

describe('requiresNoTemperatureWithThinking', () => {
  it('is true for all Claude 4 families', () => {
    expect(requiresNoTemperatureWithThinking(OPUS_48)).toBe(true);
    expect(requiresNoTemperatureWithThinking(SONNET_46)).toBe(true);
    expect(requiresNoTemperatureWithThinking('claude-haiku-4-5')).toBe(true);
  });

  it('is false for Claude 3.x models', () => {
    expect(requiresNoTemperatureWithThinking(SONNET_35)).toBe(false);
  });
});

describe('buildThinkingConfig', () => {
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
