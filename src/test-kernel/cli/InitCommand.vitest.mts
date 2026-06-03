import { describe, expect, it } from 'vitest';

import { defaultInitAgentOptions, initCommand } from '@cli/commands/init';

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
    const options = defaultInitAgentOptions([
      { name: 'chat', description: 'General chat' },
      { name: 'simplifier', description: 'Code simplification' },
      { name: 'review', description: 'Code review' },
    ]);

    expect(options).toEqual([
      { name: 'chat', description: 'General chat' },
      { name: 'review', description: 'Code review' },
    ]);
  });
});
