import { describe, expect, it } from 'vitest';

import {
  loginInitFromArgs,
  resolveLoginProvider,
  shouldPromptForLoginProvider,
} from '@cli/commands/auth';
import { formatCliManualAuthUrlMessage } from '@cli/runtime/supabaseAuth';

describe('CLI login arguments (texra login)', () => {
  it('marks bare texra login as using the fallback provider', () => {
    expect(resolveLoginProvider(undefined, undefined)).toEqual({
      provider: 'github',
      explicit: false,
    });
  });

  it('prefers the --provider flag over the positional argument', () => {
    expect(resolveLoginProvider('github', 'google')).toEqual({
      provider: 'google',
      explicit: true,
    });
  });

  it('falls back to the positional argument when --provider is empty', () => {
    expect(resolveLoginProvider('google', undefined)).toEqual({
      provider: 'google',
      explicit: true,
    });
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
      providerExplicit: true,
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
      providerExplicit: true,
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

  it('prompts for provider only for bare interactive text login', () => {
    const interactiveText = {
      mode: 'interactive' as const,
      outputFormat: 'text' as const,
      stdoutIsTty: true,
      termIsDumb: false,
    };

    expect(
      shouldPromptForLoginProvider(interactiveText, {
        providerExplicit: false,
        noBrowser: false,
      }),
    ).toBe(true);
    expect(
      shouldPromptForLoginProvider(interactiveText, {
        providerExplicit: true,
        noBrowser: false,
      }),
    ).toBe(false);
    expect(
      shouldPromptForLoginProvider(interactiveText, {
        providerExplicit: false,
        noBrowser: true,
      }),
    ).toBe(false);
    expect(
      shouldPromptForLoginProvider(
        { ...interactiveText, outputFormat: 'json' },
        { providerExplicit: false, noBrowser: false },
      ),
    ).toBe(false);
    expect(
      shouldPromptForLoginProvider(
        { ...interactiveText, mode: 'headless' },
        { providerExplicit: false, noBrowser: false },
      ),
    ).toBe(false);
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
