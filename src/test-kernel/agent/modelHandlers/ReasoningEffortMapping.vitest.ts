// Third-party imports
import { describe, it, expect } from 'vitest';
import { ReasoningEffort } from 'llm-zoo';

// Local imports - mapping under test
import { toOpenRouterReasoningEffort } from '@agent/modelHandlers/modelHandlerOpenRouterNative';

// Regression coverage for the SDK-vocabulary mismatch that produced
// `400 reasoning_effort: Invalid option: expected one of
// "xhigh"|"high"|"medium"|"low"|"minimal"|"none"`. TeXRA's internal tier enum
// (llm-zoo) carries a `max` value that neither the OpenAI nor the OpenRouter
// SDK accepts, so it must be remapped to their top tier (`xhigh`) before send.
describe('toOpenRouterReasoningEffort', () => {
  it('maps the internal "max" tier to OpenRouter\'s top tier "xhigh"', () => {
    // OpenRouter (and OpenAI) reject "max"; previously this fell through to the
    // default branch and silently downgraded the user's maximum to "low".
    expect(toOpenRouterReasoningEffort(ReasoningEffort.MAX)).toBe('xhigh');
  });

  it('passes through every value OpenRouter natively accepts', () => {
    for (const effort of [
      'xhigh',
      'high',
      'medium',
      'low',
      'minimal',
      'none',
    ]) {
      expect(toOpenRouterReasoningEffort(effort)).toBe(effort);
    }
  });

  it('falls back to "low" for unrecognized values', () => {
    expect(toOpenRouterReasoningEffort('bogus')).toBe('low');
  });
});
