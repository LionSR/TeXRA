import { describe, expect, it } from 'vitest';

import type { ModelOptionData, ToolDefinition } from '@shared/schemas';
import {
  availableModelNamesFromOptions,
  selectDelegationModelFromAvailableNames,
  withDelegationModelAvailability,
} from '@tools/delegation/delegationAvailability';

function model(
  value: string,
  overrides: Partial<ModelOptionData> = {},
): ModelOptionData {
  return {
    value,
    label: value,
    ...overrides,
  };
}

describe('delegation model availability', () => {
  it('filters model options to only currently runnable models', () => {
    expect(
      availableModelNamesFromOptions([
        model('sonnet46T'),
        model('opus48T', { disabled: true }),
        model('gemini31p', { requiresKey: true, availability: 'missing-key' }),
        model('deepseekT', { disabled: false, requiresKey: false }),
      ]),
    ).toEqual(['sonnet46T', 'deepseekT']);
  });

  it('replaces the delegation tool description with current available models', () => {
    const tool: ToolDefinition = {
      name: 'delegate_agent',
      description: [
        'Delegate to a specialist.',
        'Available models: opus48T, sonnet46T, gemini31p',
        'Model selection: use the largest available model when needed.',
      ].join('\n'),
    };

    const rewritten = withDelegationModelAvailability(tool, [
      'sonnet46T',
      'deepseekT',
    ]);

    expect(rewritten.description).toContain(
      'Available models: sonnet46T, deepseekT',
    );
    expect(rewritten.description).not.toContain('opus48T');
    expect(rewritten.description).toContain(
      'Model selection: use the largest available model when needed.',
    );
  });

  it('keeps non-delegation tool descriptions unchanged', () => {
    const tool: ToolDefinition = {
      name: 'read_file',
      description: 'Available models: opus48T, sonnet46T',
    };

    expect(withDelegationModelAvailability(tool, ['sonnet46T'])).toBe(tool);
  });

  it('tells the agent not to guess models when availability cannot be loaded', () => {
    const rewritten = withDelegationModelAvailability(
      {
        name: 'delegate_workflow',
        description: 'Available models: loaded at runtime.',
      },
      null,
    );

    expect(rewritten.description).toBe(
      'Available models: unavailable to load; omit model unless the user explicitly requested one.',
    );
  });

  it('rejects an explicitly requested model that is not currently available', () => {
    expect(() =>
      selectDelegationModelFromAvailableNames({
        requestedModel: 'opus48T',
        parentModel: 'sonnet46T',
        availableModels: ['sonnet46T', 'deepseekT'],
      }),
    ).toThrow(
      'Model "opus48T" is not currently available for delegation in the active API mode. Available models: sonnet46T, deepseekT.',
    );
  });

  it('uses the parent model only when it is available', () => {
    expect(
      selectDelegationModelFromAvailableNames({
        parentModel: 'sonnet46T',
        availableModels: ['deepseekT', 'sonnet46T'],
      }),
    ).toBe('sonnet46T');

    expect(
      selectDelegationModelFromAvailableNames({
        parentModel: 'opus48T',
        availableModels: ['deepseekT', 'sonnet46T'],
      }),
    ).toBe('deepseekT');
  });

  it('rejects delegation when no models are currently available', () => {
    expect(() =>
      selectDelegationModelFromAvailableNames({
        parentModel: 'opus48T',
        availableModels: [],
      }),
    ).toThrow(
      'No models are currently available for delegation in the active API mode. Switch API mode or configure a provider API key before delegating.',
    );
  });
});
