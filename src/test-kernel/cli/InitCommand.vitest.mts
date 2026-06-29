import { describe, expect, it } from 'vitest';

import {
  defaultInitAgentOptions,
  defaultInitAnswers,
  initCommand,
} from '@cli/commands/init';
import {
  initWizardDefaultAgentIndex,
  initWizardModelSelectItems,
} from '@cli/init/runInitWizard';
import type { CliModelAccess } from '@cli/runtime/modelAccess';

function modelAccess(
  value: string,
  overrides: Partial<CliModelAccess> = {},
): CliModelAccess {
  return {
    model: { value, label: value },
    available: true,
    status: 'available',
    ...overrides,
  };
}

describe('CLI init command', () => {
  it('accepts global CLI flags while keeping init-specific cwd help', () => {
    const args = initCommand.args as Record<
      string,
      {
        readonly type?: string;
        readonly valueHint?: string;
        readonly description?: string;
      }
    >;

    expect(args).toHaveProperty('api-mode');
    expect(args).toHaveProperty('approval-policy');
    expect(args).toHaveProperty('color');
    expect(args).toHaveProperty('no-input');
    expect(args.cwd).toMatchObject({
      type: 'string',
      valueHint: 'directory',
      description: 'Working directory to initialize (defaults to $PWD)',
    });
  });

  it('does not offer simplifier as a default init agent option', () => {
    const registryAgents: Array<{ name: string; description: string }> = [
      { name: 'chat', description: 'General chat' },
      { name: 'simplifier', description: 'Code simplification' },
      { name: 'review', description: 'Code review' },
    ];
    const options = defaultInitAgentOptions(registryAgents);

    expect(options).toEqual([{ name: 'chat' }, { name: 'review' }]);
  });

  it('defaults non-interactive init to the visible team lead', () => {
    const answers = defaultInitAnswers(
      [{ name: 'research' }, { name: 'review' }],
      [modelAccess('sonnet46T')],
    );

    expect(answers.agent).toBe('research');
    expect(answers.model).toBe('sonnet46T');
  });

  it('highlights the visible team lead in the interactive init wizard', () => {
    expect(
      initWizardDefaultAgentIndex([
        { name: 'research' },
        { name: 'review' },
        { name: 'assistant' },
      ]),
    ).toBe(2);

    expect(
      initWizardDefaultAgentIndex([{ name: 'research' }, { name: 'review' }]),
    ).toBe(0);
  });

  it('disables init model rows unavailable in the active API mode', () => {
    expect(
      initWizardModelSelectItems([
        modelAccess('sonnet46T', {
          model: { value: 'sonnet46T', label: 'Sonnet' },
          available: true,
          status: 'included access',
        }),
        modelAccess('deepseekT', {
          model: { value: 'deepseekT', label: 'DeepSeek' },
          available: false,
          status: 'api key set',
        }),
      ]),
    ).toEqual([
      {
        value: 'sonnet46T',
        label: 'Sonnet',
        description: 'included access',
        disabled: false,
      },
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        description: 'api key set (unavailable now)',
        disabled: true,
      },
    ]);
  });

  it('keeps all-unavailable init model rows selectable as a fallback', () => {
    expect(
      initWizardModelSelectItems([
        modelAccess('sonnet46T', {
          model: { value: 'sonnet46T', label: 'Sonnet' },
          available: false,
          status: 'login required',
        }),
        modelAccess('deepseekT', {
          model: { value: 'deepseekT', label: 'DeepSeek' },
          available: false,
          status: 'missing key',
        }),
      ]),
    ).toEqual([
      {
        value: 'sonnet46T',
        label: 'Sonnet',
        description: 'login required (unavailable now)',
        disabled: false,
      },
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        description: 'missing key (unavailable now)',
        disabled: false,
      },
    ]);
  });
});
