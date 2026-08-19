import { describe, expect, it } from 'vitest';

import {
  formatCliApiStatusActionHint,
  formatCliAuthStatusLine,
} from '@cli/runtime/apiStatus';

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

  it.each<
    [
      Parameters<typeof formatCliApiStatusActionHint>[0],
      Parameters<typeof formatCliApiStatusActionHint>[1],
      string,
    ]
  >([
    [
      { authenticated: true },
      undefined,
      'actions: choose Model access below; `texra logout` signs out',
    ],
    [
      { authenticated: false },
      undefined,
      'actions: choose Model access below, or add a provider key',
    ],
    [
      { authenticated: false },
      { hasPersonalKey: true },
      'actions: choose Model access below; provider keys are configured',
    ],
  ])('formats the action hint (%#)', (auth, options, expected) => {
    expect(formatCliApiStatusActionHint(auth, options)).toBe(expected);
  });
});
