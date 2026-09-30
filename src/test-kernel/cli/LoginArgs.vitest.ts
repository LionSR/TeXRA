import { describe, expect, it } from 'vitest';

import { parseChatLoginSlashArgs } from '@cli/runtime/loginOptions';

describe('CLI in-chat login arguments (/login)', () => {
  it.each<{
    input: string;
    expected: NonNullable<ReturnType<typeof parseChatLoginSlashArgs>>;
  }>([
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
    '',
    'slack',
    'github',
    'chatgpt grok',
    'chatgpt --select-account',
    '--unexpected',
  ])('rejects invalid in-chat login slash command options: "%s"', (input) => {
    expect(parseChatLoginSlashArgs(input)).toBeUndefined();
  });
});
