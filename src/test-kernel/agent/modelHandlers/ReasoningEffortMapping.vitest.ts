// Third-party imports
import { describe, it, expect } from 'vitest';
import { ReasoningEffort } from 'llm-zoo';

// Local imports - mappings under test
import { toOpenRouterReasoningEffort } from '@agent/modelHandlers/openrouter/openRouterStreaming';
import {
  clampReasoningEffortToHighOrMax,
  toOpenAIReasoningEffort,
} from '@agent/modelHandlers/support/reasoningEffort';

// Regression coverage for the SDK-vocabulary mismatch that produced
// `400 reasoning_effort: Invalid option: expected one of
// "xhigh"|"high"|"medium"|"low"|"minimal"|"none"`. TeXRA's internal tier enum
// (llm-zoo) carries provider-specific tiers, so conversion must obey the
// receiving SDK vocabulary and the model's declared native ceiling.
describe('toOpenAIReasoningEffort', () => {
  it('uses the historical OpenAI ceiling/floor without a max declaration', () => {
    expect(toOpenAIReasoningEffort(ReasoningEffort.MAX)).toBe('xhigh');
    expect(toOpenAIReasoningEffort(ReasoningEffort.NONE)).toBe('low');
  });

  it('preserves max when llm-zoo declares it as the model ceiling', () => {
    expect(
      toOpenAIReasoningEffort(ReasoningEffort.MAX, ReasoningEffort.MAX),
    ).toBe('max');
  });

  it('passes through values OpenAI natively accepts', () => {
    expect(toOpenAIReasoningEffort(ReasoningEffort.XHIGH)).toBe('xhigh');
    expect(toOpenAIReasoningEffort(ReasoningEffort.HIGH)).toBe('high');
    expect(toOpenAIReasoningEffort(ReasoningEffort.MEDIUM)).toBe('medium');
    expect(toOpenAIReasoningEffort(ReasoningEffort.LOW)).toBe('low');
  });
});

describe('toOpenRouterReasoningEffort', () => {
  it('preserves max only when the model declares native support', () => {
    expect(toOpenRouterReasoningEffort(ReasoningEffort.MAX, true)).toBe('max');
    expect(toOpenRouterReasoningEffort(ReasoningEffort.MAX, false)).toBe(
      'xhigh',
    );
  });

  it.each(['xhigh', 'high', 'medium', 'low', 'minimal', 'none'])(
    'passes %s through unchanged when OpenRouter natively accepts it',
    (effort) => {
      expect(toOpenRouterReasoningEffort(effort, false)).toBe(effort);
    },
  );

  it('falls back to "low" for unrecognized values', () => {
    expect(toOpenRouterReasoningEffort('bogus', false)).toBe('low');
  });
});

// Shared clamp for providers (DeepSeek, GLM) whose OpenAI-compatible surface
// accepts only 'high' and 'max'. Previously copy-pasted in both handlers.
describe('clampReasoningEffortToHighOrMax', () => {
  it('maps the above-high tiers to "max"', () => {
    expect(clampReasoningEffortToHighOrMax(ReasoningEffort.XHIGH)).toBe('max');
    expect(clampReasoningEffortToHighOrMax(ReasoningEffort.MAX)).toBe('max');
  });

  it.each([
    ReasoningEffort.HIGH,
    ReasoningEffort.MEDIUM,
    ReasoningEffort.LOW,
    ReasoningEffort.NONE,
  ])('maps %s and every below-high tier to the "high" floor', (effort) => {
    expect(clampReasoningEffortToHighOrMax(effort)).toBe('high');
  });
});
