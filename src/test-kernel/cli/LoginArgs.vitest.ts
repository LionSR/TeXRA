import { describe, expect, it } from 'vitest';

import {
  assertLoginTransportExclusive,
  loginInitFromArgs,
  shouldPromptForLoginProvider,
} from '@cli/commands/auth';
import { CliUsageError } from '@cli/runtime/cliContext';
import {
  githubSelectAccountWarning,
  hasLoginTransportConflict,
  LOGIN_TRANSPORT_CONFLICT_MESSAGE,
  parseChatLoginSlashArgs,
  unsupportedLoginProviderMessage,
} from '@cli/runtime/loginOptions';
import { formatCliManualAuthUrlMessage } from '@cli/runtime/supabaseAuth';

describe('CLI login arguments (texra login)', () => {
  it('marks bare texra login as using the fallback provider', () => {
    expect(loginInitFromArgs({})).toMatchObject({
      provider: 'github',
      providerExplicit: false,
    });
    expect(loginInitFromArgs({ providerArg: '  ' })).toMatchObject({
      provider: 'github',
      providerExplicit: false,
    });
  });

  it('takes the provider from the positional argument', () => {
    expect(loginInitFromArgs({ providerArg: 'google' })).toMatchObject({
      provider: 'google',
      providerExplicit: true,
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
        providerArg: 'google',
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

  it.each<{
    input: string;
    expected: NonNullable<ReturnType<typeof parseChatLoginSlashArgs>>;
  }>([
    {
      input: '',
      expected: {
        target: 'texra',
        provider: 'github',
        noBrowser: false,
        device: false,
        selectAccount: false,
        loginHint: undefined,
      },
    },
    {
      input: 'google --no-browser --select-account',
      expected: {
        target: 'texra',
        provider: 'google',
        noBrowser: true,
        device: false,
        selectAccount: true,
        loginHint: undefined,
      },
    },
    {
      input: '--login-hint user@example.edu',
      expected: {
        target: 'texra',
        provider: 'github',
        noBrowser: false,
        device: false,
        selectAccount: false,
        loginHint: 'user@example.edu',
      },
    },
    {
      input: 'github --login-hint=octocat',
      expected: {
        target: 'texra',
        provider: 'github',
        noBrowser: false,
        device: false,
        selectAccount: false,
        loginHint: 'octocat',
      },
    },
    {
      input: 'texra github --device',
      expected: {
        target: 'texra',
        provider: 'github',
        noBrowser: false,
        device: true,
        selectAccount: false,
        loginHint: undefined,
      },
    },
    {
      input: 'chatgpt',
      expected: { target: 'chatgpt', noBrowser: false, device: false },
    },
    {
      input: 'chatgpt --device',
      expected: { target: 'chatgpt', noBrowser: false, device: true },
    },
    {
      input: 'codex --no-browser',
      expected: { target: 'chatgpt', noBrowser: true, device: false },
    },
    {
      input: 'grok',
      expected: { target: 'grok', noBrowser: false, device: false },
    },
    {
      input: 'xai --device',
      expected: { target: 'grok', noBrowser: false, device: true },
    },
  ])(
    'parses in-chat login slash command options through the same runtime owner: "$input"',
    ({ input, expected }) => {
      expect(parseChatLoginSlashArgs(input)).toEqual(expected);
    },
  );

  it('parses a bare --device as a texra device login', () => {
    expect(parseChatLoginSlashArgs('--device')).toMatchObject({
      target: 'texra',
      device: true,
      noBrowser: false,
    });
  });

  it.each([
    { device: true, noBrowser: true, expected: true },
    { device: true, noBrowser: false, expected: false },
    { device: false, noBrowser: true, expected: false },
    { device: false, noBrowser: false, expected: false },
  ])(
    'treats --device and --no-browser as a transport conflict only when both are set (device=$device, noBrowser=$noBrowser)',
    ({ device, noBrowser, expected }) => {
      expect(hasLoginTransportConflict({ device, noBrowser })).toBe(expected);
    },
  );

  it('rejects --device + --no-browser from the CLI login command', () => {
    expect(() =>
      assertLoginTransportExclusive({ device: true, noBrowser: true }),
    ).toThrow(CliUsageError);
    expect(() =>
      assertLoginTransportExclusive({ device: true, noBrowser: true }),
    ).toThrow(LOGIN_TRANSPORT_CONFLICT_MESSAGE);
    expect(() =>
      assertLoginTransportExclusive({ device: true, noBrowser: false }),
    ).not.toThrow();
    expect(() =>
      assertLoginTransportExclusive({ device: false, noBrowser: true }),
    ).not.toThrow();
  });

  it.each([
    'slack',
    'github google',
    'chatgpt github',
    'chatgpt --select-account',
    'chatgpt --login-hint user@example.edu',
    '--login-hint',
    '--login-hint --no-browser',
    '--unexpected',
  ])('rejects invalid in-chat login slash command options: "%s"', (input) => {
    expect(parseChatLoginSlashArgs(input)).toBeUndefined();
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

  const interactiveText = {
    mode: 'interactive' as const,
    outputFormat: 'text' as const,
    stdoutIsTty: true,
    termIsDumb: false,
  };

  it.each<{
    context: Parameters<typeof shouldPromptForLoginProvider>[0];
    init: Parameters<typeof shouldPromptForLoginProvider>[1];
    expected: boolean;
  }>([
    {
      context: interactiveText,
      init: { providerExplicit: false, noBrowser: false, device: false },
      expected: true,
    },
    {
      context: interactiveText,
      init: { providerExplicit: true, noBrowser: false, device: false },
      expected: false,
    },
    {
      context: interactiveText,
      init: { providerExplicit: false, noBrowser: true, device: false },
      expected: false,
    },
    {
      // Device logins pick the provider in the browser, never in the terminal.
      context: interactiveText,
      init: { providerExplicit: false, noBrowser: false, device: true },
      expected: false,
    },
    {
      context: { ...interactiveText, outputFormat: 'json' },
      init: { providerExplicit: false, noBrowser: false, device: false },
      expected: false,
    },
    {
      context: { ...interactiveText, mode: 'headless' },
      init: { providerExplicit: false, noBrowser: false, device: false },
      expected: false,
    },
  ])(
    'prompts for provider only for bare interactive text login (init=$init, context=$context, expected=$expected)',
    ({ context, init, expected }) => {
      expect(shouldPromptForLoginProvider(context, init)).toBe(expected);
    },
  );

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
