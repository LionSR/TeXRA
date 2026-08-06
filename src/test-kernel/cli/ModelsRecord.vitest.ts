import { describe, expect, it } from 'vitest';

import {
  cliModelRecord,
  formatNoListableModelsMessage,
  listableModelAccessEntries,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
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

function access(
  value: string,
  overrides: Partial<CliModelAccess> = {},
): CliModelAccess {
  return {
    model: model({ value, label: value }),
    available: true,
    status: 'included access',
    ...overrides,
  };
}

/** A model excluded from the current access tier. */
function unavailableAccess(value: string): CliModelAccess {
  return access(value, {
    available: false,
    status: 'not included',
    model: model({
      value,
      label: value,
      availability: 'not-included',
      availabilityLabel: 'Not included',
      disabled: true,
    }),
  });
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

describe('CLI model list filtering', () => {
  it('lists only currently runnable models by default', () => {
    const entries = [
      access('sonnet46T'),
      unavailableAccess('opus48T'),
      access('deepseekT'),
    ];

    expect(
      listableModelAccessEntries(entries).map((entry) => entry.model.value),
    ).toEqual(['sonnet46T', 'deepseekT']);
  });

  it('lists only models marked runnable by the loaded access list', () => {
    const includedModeEntries = [
      access('sonnet46T', {
        model: model({ value: 'sonnet46T', availability: 'included-access' }),
      }),
      access('deepseekT', {
        available: false,
        model: model({ value: 'deepseekT', availability: 'provider-key' }),
      }),
      access('openrouterOnlyT', {
        available: false,
        model: model({
          value: 'openrouterOnlyT',
          availability: 'openrouter-key',
        }),
      }),
    ];

    expect(
      listableModelAccessEntries(includedModeEntries).map(
        (entry) => entry.model.value,
      ),
    ).toEqual(['sonnet46T']);
  });

  it('does not recompute availability from model metadata', () => {
    const personalModeEntries = [
      access('sonnet46T', {
        available: false,
        model: model({ value: 'sonnet46T', availability: 'included-access' }),
      }),
      access('deepseekT', {
        model: model({ value: 'deepseekT', availability: 'provider-key' }),
      }),
      access('openrouterOnlyT', {
        model: model({
          value: 'openrouterOnlyT',
          availability: 'openrouter-key',
        }),
      }),
    ];

    expect(
      listableModelAccessEntries(personalModeEntries).map(
        (entry) => entry.model.value,
      ),
    ).toEqual(['deepseekT', 'openrouterOnlyT']);
  });

  it('keeps unavailable models for the explicit diagnostic view', () => {
    const entries = [access('sonnet46T'), unavailableAccess('opus48T')];

    expect(
      listableModelAccessEntries(entries, { includeUnavailable: true }).map(
        (entry) => entry.model.value,
      ),
    ).toEqual(['sonnet46T', 'opus48T']);
  });
});

describe('CLI model list empty-state text', () => {
  it('points personal-key users at included access and model status diagnostics', () => {
    expect(formatNoListableModelsMessage('personal')).toBe(
      [
        'No models are currently available.',
        'Run `texra models list --all` to see unavailable models and access status.',
        'Add a provider API key with `texra setup`, or retry with `--api-mode included` and run `texra login`.',
      ].join('\n'),
    );
  });

  it('points included-mode users at login or personal API key setup', () => {
    expect(formatNoListableModelsMessage('included')).toContain(
      'Run `texra login` for included access, or retry with `--api-mode personal` after configuring a provider API key.',
    );
  });

  it('uses a combined hint when no API mode was explicitly selected', () => {
    expect(formatNoListableModelsMessage(undefined)).toBe(
      [
        'No models are currently available.',
        'Run `texra models list --all` to see unavailable models and access status.',
        'Run `texra login`, retry with `--api-mode included`, or add a provider API key with `texra setup`.',
      ].join('\n'),
    );
  });

  it('does not suggest --all when unavailable models were already requested', () => {
    const text = formatNoListableModelsMessage('personal', {
      includeUnavailable: true,
    });

    expect(text).toContain('No models are currently available.');
    expect(text).not.toContain('models list --all');
  });
});
