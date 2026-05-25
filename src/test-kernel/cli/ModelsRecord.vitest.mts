import { describe, expect, it } from 'vitest';

import { cliModelRecord } from '@cli/commands/models';
import type { ModelOptionData } from '@shared/schemas';

function model(overrides: Partial<ModelOptionData> = {}): ModelOptionData {
  return {
    value: 'sonnet46T',
    label: 'Sonnet 4.6 (Thinking)',
    provider: 'anthropic',
    context: '1.0M',
    cost: '$3.000/$15.000',
    hint: '1M context',
    availability: 'included-access',
    availabilityLabel: 'Included access',
    requiresKey: false,
    disabled: false,
    ...overrides,
  } as ModelOptionData;
}

describe('CLI model JSON record', () => {
  it('exposes an `id` field aliased to `value` for cross-resource addressability', () => {
    const record = cliModelRecord(model());

    expect(record.id).toBe('sonnet46T');
    // `value` is preserved for backward compatibility with existing scripts.
    expect(record.value).toBe('sonnet46T');
    // `id` must appear before `value` so callers using `Object.keys()[0]`
    // (and human readers) see the canonical key first.
    expect(Object.keys(record)[0]).toBe('id');
  });

  it('does not drop any of the upstream model fields', () => {
    const m = model({
      provider: 'openai',
      cost: '$1.250/$10.000',
      availabilityLabel: 'Personal key',
      requiresKey: true,
    });
    const record = cliModelRecord(m);

    for (const key of Object.keys(m)) {
      expect(record).toHaveProperty(key);
      expect(record[key as keyof typeof record]).toEqual(
        m[key as keyof ModelOptionData],
      );
    }
  });

  it('snapshots the source `value` so post-call mutation does not bleed in', () => {
    // Guards against a future regression where `cliModelRecord` is rewritten
    // to return a reference instead of a copy: mutating `m.value` after the
    // projection must not change the record's `id` or `value`.
    const m = model({ value: 'gpt55' });
    const record = cliModelRecord(m);

    (m as { value: string }).value = 'mutated-after-call';

    expect(record.id).toBe('gpt55');
    expect(record.value).toBe('gpt55');
  });
});
