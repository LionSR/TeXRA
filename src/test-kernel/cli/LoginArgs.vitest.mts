import { describe, expect, it } from 'vitest';

import { loginInitFromArgs, resolveLoginProvider } from '@cli/commands/auth';
import { formatCliManualAuthUrlMessage } from '@cli/runtime/supabaseAuth';

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

  it('reads login flags from hyphenated argument keys', () => {
    expect(
      loginInitFromArgs({
        providerArg: 'github',
        'no-browser': true,
        'select-account': true,
        'login-hint': 'octocat',
      }),
    ).toEqual({
      provider: 'github',
      noBrowser: true,
      selectAccount: true,
      loginHint: 'octocat',
    });
  });

  it('reads login flags from camelCase argument keys', () => {
    expect(
      loginInitFromArgs({
        provider: 'google',
        noBrowser: true,
        selectAccount: true,
        loginHint: 'person@example.com',
      }),
    ).toEqual({
      provider: 'google',
      noBrowser: true,
      selectAccount: true,
      loginHint: 'person@example.com',
    });
  });

  it('treats citty negated browser output as --no-browser', () => {
    expect(loginInitFromArgs({ browser: false })).toMatchObject({
      noBrowser: true,
    });
  });

  it('describes manual login as a loopback callback, not any-device auth', () => {
    const message = formatCliManualAuthUrlMessage(
      'http://127.0.0.1:49152/auth-callback',
    );

    expect(message).toContain(
      'Open this URL in a browser that can reach this terminal session:',
    );
    expect(message).toContain('http://127.0.0.1:49152/auth-callback');
    expect(message).toContain('Remote SSH/container users');
    expect(message).not.toContain('any device');
  });
});
