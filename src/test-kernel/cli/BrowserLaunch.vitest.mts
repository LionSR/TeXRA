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

  it('uses verbatim cmd start quoting on Windows', () => {
    expect(
      resolveBrowserLaunch('https://example.com/pr?title=a"b', 'win32'),
    ).toEqual({
      command: 'cmd',
      args: ['/d', '/s', '/c', 'start "" "https://example.com/pr?title=a%22b"'],
      windowsVerbatimArguments: true,
    });
  });
});
