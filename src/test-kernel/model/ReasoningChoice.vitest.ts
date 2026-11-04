import { describe, expect, it } from 'vitest';

import {
  chooseReasoning,
  type ModelConfig,
  ModelProvider,
  ReasoningEffort as E,
} from '@texra-ai/llm';

type Spec = Pick<ModelConfig, 'label' | 'provider' | 'reasoning' | 'modes'>;

const model = (
  reasoning: ModelConfig['reasoning'],
  modes?: Spec['modes'],
): Spec => ({
  label: 'Test model',
  provider: ModelProvider.OTHERS,
  reasoning,
  ...(modes && { modes }),
});

const FULL = [E.LOW, E.MEDIUM, E.HIGH, E.XHIGH, E.MAX] as const;
// Always thinks, all five levels (Fable 5.1).
const alwaysThinks = model({ efforts: FULL });
const neverThinks = model(undefined);

describe('chooseReasoning', () => {
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
