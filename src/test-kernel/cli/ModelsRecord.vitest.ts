import { describe, expect, it } from 'vitest';

import {
  cliModelRecord,
  listableModelAccessEntries,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import type { ModelOptionData } from '@shared/schemas';

function model(overrides: Partial<ModelOptionData> = {}): ModelOptionData {
  return {
    value: 'anthropic/claude-sonnet-4-6',
    label: 'Sonnet 4.6 (Thinking)',
    provider: 'anthropic',
    context: '1.0M',
    cost: '$3.000/$15.000',
    hint: '1M context',
    availability: 'provider-key',
    ...overrides,
  } as ModelOptionData;
}

function access(
  value: string,
  overrides: Partial<CliModelAccess> = {},
): CliModelAccess {
  return {
    model: model({ value, label: value }),
    available: true,
    status: 'api key set',
    ...overrides,
  };
}

describe('CLI model JSON record', () => {
  it('exposes the model id under `id` only, for cross-resource addressability', () => {
    const record = cliModelRecord(model());

    expect(record.id).toBe('anthropic/claude-sonnet-4-6');
    // `id` is the single spelling; the internal `value` key does not leak.
    expect(record).not.toHaveProperty('value');
    // `id` must appear first so callers using `Object.keys()[0]`
    // (and human readers) see the canonical key first.
    expect(Object.keys(record)[0]).toBe('id');
  });
});

describe('CLI model list filtering', () => {
  it('does not recompute availability from model metadata', () => {
    const personalModeEntries = [
      access('anthropic/claude-sonnet-4-6', {
        available: false,
        model: model({
          value: 'anthropic/claude-sonnet-4-6',
          availability: 'provider-key',
        }),
      }),
      access('deepseek/deepseek-v4-flash', {
        model: model({
          value: 'deepseek/deepseek-v4-flash',
          availability: 'provider-key',
        }),
      }),
    ];

    expect(
      listableModelAccessEntries(personalModeEntries).map(
        (entry) => entry.model.value,
      ),
    ).toEqual(['deepseek/deepseek-v4-flash']);
  });
});
