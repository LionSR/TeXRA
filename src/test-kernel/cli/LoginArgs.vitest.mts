import { describe, expect, it } from 'vitest';

import {
  loginInitFromArgs,
  shouldPromptForLoginProvider,
} from '@cli/commands/auth';
import {
  githubSelectAccountWarning,
  parseChatLoginSlashArgs,
  resolveLoginProvider,
  unsupportedLoginProviderMessage,
} from '@cli/runtime/loginOptions';
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
      device: false,
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
      device: false,
      selectAccount: true,
      loginHint: 'person@example.com',
    });
  });

  it('reads the --device flag', () => {
    expect(loginInitFromArgs({ device: true })).toMatchObject({
      device: true,
      providerExplicit: false,
    });
    expect(loginInitFromArgs({})).toMatchObject({ device: false });
  });

  it('treats citty negated browser output as --no-browser', () => {
    expect(loginInitFromArgs({ browser: false })).toMatchObject({
      noBrowser: true,
    });
  });

  it('parses in-chat login slash command options through the same runtime owner', () => {
    expect(parseChatLoginSlashArgs('')).toEqual({
      target: 'texra',
      provider: 'github',
      noBrowser: false,
      device: false,
      selectAccount: false,
      loginHint: undefined,
    });
    expect(
      parseChatLoginSlashArgs('google --no-browser --select-account'),
    ).toEqual({
      target: 'texra',
      provider: 'google',
      noBrowser: true,
      device: false,
      selectAccount: true,
      loginHint: undefined,
    });
    expect(parseChatLoginSlashArgs('--login-hint user@example.edu')).toEqual({
      target: 'texra',
      provider: 'github',
      noBrowser: false,
      device: false,
      selectAccount: false,
      loginHint: 'user@example.edu',
    });
    expect(parseChatLoginSlashArgs('github --login-hint=octocat')).toEqual({
      target: 'texra',
      provider: 'github',
      noBrowser: false,
      device: false,
      selectAccount: false,
      loginHint: 'octocat',
    });
    expect(parseChatLoginSlashArgs('texra github --device')).toEqual({
      target: 'texra',
      provider: 'github',
      noBrowser: false,
      device: true,
      selectAccount: false,
      loginHint: undefined,
    });
    expect(parseChatLoginSlashArgs('chatgpt')).toEqual({
      target: 'chatgpt',
      noBrowser: false,
      device: false,
    });
    expect(parseChatLoginSlashArgs('chatgpt --device')).toEqual({
      target: 'chatgpt',
      noBrowser: false,
      device: true,
    });
    expect(parseChatLoginSlashArgs('codex --no-browser')).toEqual({
      target: 'chatgpt',
      noBrowser: true,
      device: false,
    });
    expect(parseChatLoginSlashArgs('--device')).toMatchObject({
      target: 'texra',
      device: true,
      noBrowser: false,
    });
  });

  it('rejects invalid in-chat login slash command options', () => {
    expect(parseChatLoginSlashArgs('slack')).toBeUndefined();
    expect(parseChatLoginSlashArgs('github google')).toBeUndefined();
    expect(parseChatLoginSlashArgs('chatgpt github')).toBeUndefined();
    expect(parseChatLoginSlashArgs('chatgpt --select-account')).toBeUndefined();
    expect(
      parseChatLoginSlashArgs('chatgpt --login-hint user@example.edu'),
    ).toBeUndefined();
    expect(parseChatLoginSlashArgs('--login-hint')).toBeUndefined();
    expect(
      parseChatLoginSlashArgs('--login-hint --no-browser'),
    ).toBeUndefined();
    expect(parseChatLoginSlashArgs('--unexpected')).toBeUndefined();
  });

  it('formats login provider policy messages from one runtime owner', () => {
    expect(unsupportedLoginProviderMessage('slack')).toBe(
      'Unsupported provider: slack. Expected github or google.',
    );
    expect(
      githubSelectAccountWarning({
        provider: 'github',
        selectAccount: true,
      }),
    ).toBe(
      'GitHub does not support --select-account by itself. Use --login-hint <username> to request a specific GitHub account.',
    );
    expect(
      githubSelectAccountWarning({
        provider: 'google',
        selectAccount: true,
      }),
    ).toBeUndefined();
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
        device: false,
      }),
    ).toBe(true);
    expect(
      shouldPromptForLoginProvider(interactiveText, {
        providerExplicit: true,
        noBrowser: false,
        device: false,
      }),
    ).toBe(false);
    expect(
      shouldPromptForLoginProvider(interactiveText, {
        providerExplicit: false,
        noBrowser: true,
        device: false,
      }),
    ).toBe(false);
    // Device logins pick the provider in the browser, never in the terminal.
    expect(
      shouldPromptForLoginProvider(interactiveText, {
        providerExplicit: false,
        noBrowser: false,
        device: true,
      }),
    ).toBe(false);
    expect(
      shouldPromptForLoginProvider(
        { ...interactiveText, outputFormat: 'json' },
        { providerExplicit: false, noBrowser: false, device: false },
      ),
    ).toBe(false);
    expect(
      shouldPromptForLoginProvider(
        { ...interactiveText, mode: 'headless' },
        { providerExplicit: false, noBrowser: false, device: false },
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
