import { describe, expect, it } from 'vitest';

import {
  normalizeRootShortcuts,
  reorderGlobalFlags,
  resolveLoginProvider,
} from '../../../packages/cli/src/commands/root';

describe('CLI root argument routing', () => {
  it('routes top-level --logout to the logout subcommand', () => {
    expect(normalizeRootShortcuts(['--logout'])).toEqual(['logout']);
  });

  it('preserves global flags when routing top-level --logout', () => {
    expect(
      normalizeRootShortcuts(['--output-format', 'json', '--logout']),
    ).toEqual(['logout', '--output-format', 'json']);
  });

  it('does not rewrite subcommand-scoped --logout flags', () => {
    expect(normalizeRootShortcuts(['chat', '--logout'])).toEqual([
      'chat',
      '--logout',
    ]);
  });

  it('does not rewrite unknown leading flags before --logout', () => {
    expect(normalizeRootShortcuts(['--unknown', '--logout'])).toEqual([
      '--unknown',
      '--logout',
    ]);
  });

  it('keeps leading global flags attached to explicit subcommands', () => {
    expect(reorderGlobalFlags(['--output-format', 'json', 'auth'])).toEqual([
      'auth',
      '--output-format',
      'json',
    ]);
  });

  it('keeps unknown leading flags in place for citty to report', () => {
    expect(reorderGlobalFlags(['--unknown', 'auth'])).toEqual([
      '--unknown',
      'auth',
    ]);
  });
});

describe('CLI login arguments', () => {
  it('prefers explicit provider flags over positional providers', () => {
    expect(resolveLoginProvider('google', 'github')).toBe('github');
  });
});
