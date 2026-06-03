import { describe, expect, it } from 'vitest';

import { defaultInitAgentOptions } from '@cli/commands/init';

describe('CLI init command', () => {
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
