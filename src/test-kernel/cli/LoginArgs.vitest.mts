import { describe, expect, it } from 'vitest';

import { resolveLoginProvider } from '../../../packages/cli/src/commands/root';
import { parseSlashLoginArgs } from '../../../packages/cli/src/chat/runChat';

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

describe('Slash /login arguments (chat REPL)', () => {
  it('defaults to GitHub with no flags', () => {
    const args = parseSlashLoginArgs('');
    expect(args.provider).toBeUndefined();
    expect(args.noBrowser).toBe(false);
    expect(args.unknownFlag).toBeUndefined();
  });

  it('parses --no-browser without a provider', () => {
    const args = parseSlashLoginArgs('--no-browser');
    expect(args.provider).toBeUndefined();
    expect(args.noBrowser).toBe(true);
    expect(args.unknownFlag).toBeUndefined();
  });

  it('parses a positional provider', () => {
    expect(parseSlashLoginArgs('google').provider).toBe('google');
  });

  it('parses --provider <name>', () => {
    expect(parseSlashLoginArgs('--provider google').provider).toBe('google');
  });

  it('parses --provider=<name>', () => {
    expect(parseSlashLoginArgs('--provider=google').provider).toBe('google');
  });

  it('lets --provider win over the positional', () => {
    expect(parseSlashLoginArgs('github --provider google').provider).toBe(
      'google',
    );
  });

  it('combines provider + no-browser', () => {
    const args = parseSlashLoginArgs('--provider google --no-browser');
    expect(args.provider).toBe('google');
    expect(args.noBrowser).toBe(true);
  });

  it('surfaces unknown flags rather than silently signing in', () => {
    const args = parseSlashLoginArgs('--definitely-not-a-flag');
    expect(args.unknownFlag).toBe('--definitely-not-a-flag');
  });

  it('flags a bare --provider with no value', () => {
    const args = parseSlashLoginArgs('--provider');
    expect(args.unknownFlag).toBe('--provider (missing value)');
  });
});
