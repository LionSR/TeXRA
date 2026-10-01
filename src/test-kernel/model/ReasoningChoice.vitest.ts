import { describe, expect, it } from 'vitest';
import { ReasoningEffort as E, type ModelConfig } from 'llm-zoo';

import {
  chooseReasoning,
  defaultReasoningLevel,
  ReasoningChoiceError,
} from '@model/reasoningChoice';

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
// Thinking can be turned off only at low–high (Opus 5).
const offLowToHigh = model({ efforts: FULL, off: [E.LOW, E.MEDIUM, E.HIGH] });
// No medium level; thinking off via `none` (DeepSeek).
const gapped = model({ efforts: [E.LOW, E.HIGH, E.MAX], off: [] });
// Thinks with no effort control (Qwen hybrid, Kimi K2.7 Code).
const noLevels = model({ efforts: [] });
const neverThinks = model(undefined);

describe('snapping to the nearest level', () => {
  it('breaks a tie toward the higher level', () => {
    expect(chooseReasoning(gapped, { effort: E.MEDIUM }).effort).toBe(E.HIGH);
  });
  it('takes the closest level on either side', () => {
    const lowToHigh = model({ efforts: [E.LOW, E.MEDIUM, E.HIGH] });
    expect(chooseReasoning(lowToHigh, { effort: E.MAX }).effort).toBe(E.HIGH);
    const highUp = model({ efforts: [E.HIGH, E.MAX] });
    expect(chooseReasoning(highUp, { effort: E.LOW }).effort).toBe(E.HIGH);
  });
});

describe('chooseReasoning', () => {
  it('defaults to medium', () => {
    expect(chooseReasoning(alwaysThinks)).toEqual({
      thinking: true,
      effort: E.MEDIUM,
      mode: null,
    });
  });

  it("prefers the selection's effort over the user's saved level", () => {
    expect(
      chooseReasoning(alwaysThinks, { effort: E.HIGH }, { userEffort: E.LOW })
        .effort,
    ).toBe(E.HIGH);
    expect(
      chooseReasoning(alwaysThinks, {}, { userEffort: E.LOW }).effort,
    ).toBe(E.LOW);
  });

  it('substitutes the nearest level a model has and says so', () => {
    const choice = chooseReasoning(gapped);
    expect(choice).toMatchObject({
      thinking: true,
      effort: E.HIGH,
      requested: E.MEDIUM,
    });
    expect(choice.note).toMatch(/no medium effort; using high/);
  });

  it('refuses to substitute in strict mode', () => {
    expect(() => chooseReasoning(gapped, {}, { strict: true })).toThrow(
      ReasoningChoiceError,
    );
  });

  it('applies a route ceiling through the same rule', () => {
    expect(
      chooseReasoning(
        alwaysThinks,
        { effort: E.HIGH },
        { routeEfforts: [E.LOW, E.MEDIUM] },
      ),
    ).toMatchObject({ effort: E.MEDIUM, requested: E.HIGH });
  });

  it('turns thinking off with none where the model allows it', () => {
    expect(chooseReasoning(gapped, { effort: E.NONE })).toEqual({
      thinking: false,
      effort: null,
      mode: null,
    });
  });

  it('never turns thinking off on a model that always thinks', () => {
    expect(() => chooseReasoning(alwaysThinks, { effort: E.NONE })).toThrow(
      /cannot turn thinking off/,
    );
  });

  it("ignores a saved none on a model that always thinks, since only the user's default asked", () => {
    expect(chooseReasoning(alwaysThinks, {}, { userEffort: E.NONE })).toEqual({
      thinking: true,
      effort: E.MEDIUM,
      mode: null,
    });
  });

  it('keeps an effort with thinking off only where the model accepts it', () => {
    expect(
      chooseReasoning(offLowToHigh, { effort: E.HIGH, thinking: false }),
    ).toEqual({ thinking: false, effort: E.HIGH, mode: null });
    expect(
      chooseReasoning(offLowToHigh, { effort: E.MAX, thinking: false }),
    ).toMatchObject({ thinking: false, effort: E.HIGH, requested: E.MAX });
  });

  it('thinks without a level on a model that has no effort control', () => {
    expect(chooseReasoning(noLevels, { effort: E.HIGH })).toEqual({
      thinking: true,
      effort: null,
      mode: null,
    });
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

  it('accepts a mode only on a model that has it', () => {
    const pro = model({ efforts: FULL, off: [] }, ['pro']);
    expect(chooseReasoning(pro, { mode: 'pro' }).mode).toBe('pro');
    expect(() => chooseReasoning(alwaysThinks, { mode: 'pro' })).toThrow(
      /no pro mode/,
    );
  });
});

describe('defaultReasoningLevel', () => {
  it('reports what an unconfigured run uses', () => {
    expect(defaultReasoningLevel(alwaysThinks)).toBe(E.MEDIUM);
    expect(defaultReasoningLevel(gapped)).toBe(E.HIGH);
    expect(defaultReasoningLevel(noLevels)).toBeUndefined();
    expect(defaultReasoningLevel(neverThinks)).toBe(E.NONE);
  });
});
