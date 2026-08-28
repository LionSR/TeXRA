import { describe, expect, it } from 'vitest';

import { formatCliAuthStatusLine } from '@cli/runtime/apiStatus';

describe('CLI API status text', () => {
  it.each<[Parameters<typeof formatCliAuthStatusLine>[0], string]>([
    [
      { authenticated: true, accountLabel: 'researcher@example.com' },
      'auth: signed in as researcher@example.com',
    ],
    // Non-email account labels stay readable.
    [
      { authenticated: true, accountLabel: 'github-user' },
      'auth: signed in as github-user',
    ],
    [
      { authenticated: true, accountLabel: 'team@internal' },
      'auth: signed in as team@internal',
    ],
    [{ authenticated: true }, 'auth: signed in'],
    [{ authenticated: false }, 'auth: signed out'],
  ])('formats auth status %j as "%s"', (status, expected) => {
    expect(formatCliAuthStatusLine(status)).toBe(expected);
  });
});
