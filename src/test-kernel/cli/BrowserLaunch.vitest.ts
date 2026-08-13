import { describe, expect, it } from 'vitest';

import { resolveBrowserLaunch } from '@cli/runtime/browser';

const SIMPLE_URL = 'https://example.com/pr';
// Percent-encoded and quoted: must reach the OS handler without cmd reparsing.
const QUOTED_URL =
  'https://example.com/compare/feature%2Fdefault...topic%2Fpr?title=a"b';

describe('resolveBrowserLaunch', () => {
  it.each<{
    platform: NodeJS.Platform;
    url: string;
    command: string;
    args: string[];
  }>([
    {
      platform: 'darwin',
      url: SIMPLE_URL,
      command: 'open',
      args: [SIMPLE_URL],
    },
    {
      platform: 'linux',
      url: SIMPLE_URL,
      command: 'xdg-open',
      args: [SIMPLE_URL],
    },
    {
      platform: 'win32',
      url: QUOTED_URL,
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', QUOTED_URL],
    },
  ])(
    'uses $command on $platform without cmd reparsing',
    ({ platform, url, command, args }) => {
      expect(resolveBrowserLaunch(url, platform)).toEqual({
        command,
        args,
      });
    },
  );
});
