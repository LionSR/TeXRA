import { describe, expect, it } from 'vitest';

import { parseChatLoginSlashArgs } from '@cli/runtime/loginOptions';

describe('CLI login arguments (texra login)', () => {
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
});
