import { describe, expect, it } from 'vitest';

import { resolveBrowserLaunch } from '@cli/runtime/browser';

describe('resolveBrowserLaunch', () => {
  it('uses open on macOS', () => {
    expect(resolveBrowserLaunch('https://example.com/pr', 'darwin')).toEqual({
      command: 'open',
      args: ['https://example.com/pr'],
      windowsVerbatimArguments: false,
    });
  });

  it('uses xdg-open on Linux-style platforms', () => {
    expect(resolveBrowserLaunch('https://example.com/pr', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com/pr'],
      windowsVerbatimArguments: false,
    });
  });

  it('uses the Windows URL handler without cmd reparsing', () => {
    expect(
      resolveBrowserLaunch(
        'https://example.com/compare/feature%2Fdefault...topic%2Fpr?title=a"b',
        'win32',
      ),
    ).toEqual({
      command: 'rundll32',
      args: [
        'url.dll,FileProtocolHandler',
        'https://example.com/compare/feature%2Fdefault...topic%2Fpr?title=a"b',
      ],
      windowsVerbatimArguments: false,
    });
  });
});
