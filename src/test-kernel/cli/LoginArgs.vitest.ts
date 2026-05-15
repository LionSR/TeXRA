import { describe, expect, it } from 'vitest';

import { parseLoginArgs } from '../../../packages/cli/src/runtime/loginArgs';

describe('CLI login arguments', () => {
  it('defaults texra login to GitHub sign-in', () => {
    expect(parseLoginArgs([])).toMatchObject({
      provider: 'github',
      noBrowser: false,
    });
  });

  it('keeps no-browser usable without an explicit provider', () => {
    expect(parseLoginArgs(['--no-browser'])).toMatchObject({
      provider: 'github',
      noBrowser: true,
    });
  });
});
