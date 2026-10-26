import { describe, expect, it } from 'vitest';
import { ReasoningEffort as E, type ModelConfig } from 'llm-zoo';

import { chooseReasoning, ReasoningChoiceError } from '@texra-ai/llm';

type Spec = Pick<ModelConfig, 'label' | 'reasoning' | 'modes'>;

const model = (
  reasoning: ModelConfig['reasoning'],
  modes?: Spec['modes'],
): Spec => ({
  label: 'Test model',
  reasoning,
  ...(modes && { modes }),
});

const FULL = [E.LOW, E.MEDIUM, E.HIGH, E.XHIGH, E.MAX] as const;
// Always thinks, all five levels (Fable 5.1).
const alwaysThinks = model({ efforts: FULL });
// No medium level; thinking off via `none` (DeepSeek).
const gapped = model({ efforts: [E.LOW, E.HIGH, E.MAX], off: [] });
const neverThinks = model(undefined);

describe('chooseReasoning', () => {
  it('refuses to substitute in strict mode', () => {
    expect(() => chooseReasoning(gapped, {}, { strict: true })).toThrow(
      ReasoningChoiceError,
    );
  });

  it('never turns thinking off on a model that always thinks', () => {
    expect(() => chooseReasoning(alwaysThinks, { effort: E.NONE })).toThrow(
      /cannot turn thinking off/,
    );
  });

  it('never makes a non-reasoning model think', () => {
    expect(chooseReasoning(neverThinks)).toEqual({
      thinking: false,
      effort: null,
      mode: null,
    });
    expect(() => chooseReasoning(neverThinks, { effort: E.HIGH })).toThrow(
      /does not reason/,
    );
  });
});
