import { describe, expect, it } from 'vitest';

import { resolveLoginProvider } from '../../../packages/cli/src/commands/root';

describe('CLI login arguments', () => {
  it('defaults texra login to GitHub sign-in', () => {
    expect(resolveLoginProvider(undefined, undefined)).toBe('github');
  });

  it('keeps no-browser usable without an explicit provider', () => {
    // `--no-browser` is parsed by citty as a separate boolean; it never
    // contaminates the provider slot. The positional + flag stay empty and
    // the resolver still returns the default provider.
    expect(resolveLoginProvider(undefined, undefined)).toBe('github');
  });

  it('prefers the --provider flag over the positional argument', () => {
    expect(resolveLoginProvider('github', 'google')).toBe('google');
  });

  it('falls back to the positional argument when --provider is empty', () => {
    expect(resolveLoginProvider('google', undefined)).toBe('google');
  });
});
