import { describe, expect, it } from 'vitest';

import { resolveLoginProvider } from '../../../packages/cli/src/commands/root';

describe('CLI login arguments (texra login)', () => {
  it('defaults texra login to GitHub sign-in', () => {
    expect(resolveLoginProvider(undefined, undefined)).toBe('github');
  });

  it('prefers the --provider flag over the positional argument', () => {
    expect(resolveLoginProvider('github', 'google')).toBe('google');
  });

  it('falls back to the positional argument when --provider is empty', () => {
    expect(resolveLoginProvider('google', undefined)).toBe('google');
  });
});
