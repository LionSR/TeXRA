import { describe, expect, it } from 'vitest';

import {
  buildAuthenticatedRemoteUrl,
  buildGitCredential,
  overleafTokenSpec,
  parseLatexGitUrl,
  redactSensitive,
} from '@latex/overleafProject';

const ID = '0123456789abcdef01234567';

const OVERLEAF_REMOTE = {
  host: 'git.overleaf.com',
  path: `/${ID}`,
  isOverleaf: true,
};

const SHARELATEX_REMOTE = {
  host: 'sharelatex.example.com',
  path: `/git/${ID}`,
  isOverleaf: false,
};

describe('parseLatexGitUrl', () => {
  it.each([
    ['a bare 24-char project id', `  ${ID}  `, OVERLEAF_REMOTE],
    ['an Overleaf git URL', `https://git.overleaf.com/${ID}`, OVERLEAF_REMOTE],
    [
      'a self-hosted ShareLaTeX git URL with /git and git@ userinfo',
      `https://git@sharelatex.example.com/git/${ID}`,
      SHARELATEX_REMOTE,
    ],
    // A www. Overleaf project URL normalizes to the git host.
    [
      'a www. Overleaf project URL',
      `https://www.overleaf.com/project/${ID}`,
      OVERLEAF_REMOTE,
    ],
    // A self-hosted project URL routes through /git.
    [
      'a self-hosted project URL',
      `https://sharelatex.example.com/project/${ID}/`,
      SHARELATEX_REMOTE,
    ],
  ])('parses %s', (_name, input, expected) => {
    expect(parseLatexGitUrl(input)).toEqual(expected);
  });

  it('returns null for unrecognized input', () => {
    expect(parseLatexGitUrl('not-a-url')).toBeNull();
    expect(parseLatexGitUrl('https://example.com/project/short')).toBeNull();
  });
});

describe('overleafTokenSpec', () => {
  it('requires an olp_ prefix for Overleaf', () => {
    const spec = overleafTokenSpec(OVERLEAF_REMOTE);
    expect(spec.tokenKey).toBe('overleaf.gitToken');
    expect(spec.tokenValidator?.('olp_abc')).toBe(true);
    expect(spec.tokenValidator?.('nope')).toBe(false);
  });

  it('namespaces the token key by host and skips validation for ShareLaTeX', () => {
    const spec = overleafTokenSpec(SHARELATEX_REMOTE);
    expect(spec.tokenKey).toBe('sharelatex.sharelatex.example.com.token');
    expect(spec.tokenValidator).toBeUndefined();
    expect(spec.tokenHint).toBeUndefined();
  });
});

describe('credential helpers', () => {
  it('url-encodes the token and tracks both forms for redaction', () => {
    const cred = buildGitCredential('olp_a/b+c');
    // Hardcoded expectations so an encoding-strategy change fails the test
    // instead of mirroring the implementation on both sides.
    expect(cred.remote).toBe('git:olp_a%2Fb%2Bc');
    expect(cred.sensitive).toEqual(['olp_a/b+c', 'olp_a%2Fb%2Bc']);
  });

  it('builds the authenticated clone URL from remote + credential', () => {
    expect(
      buildAuthenticatedRemoteUrl(OVERLEAF_REMOTE, buildGitCredential('olp_x')),
    ).toBe(`https://git:olp_x@git.overleaf.com/${ID}`);
  });

  it('redacts both the raw and encoded token forms from a message', () => {
    // A token with special chars makes the raw and encoded forms differ
    // (`olp_a/b+c` vs `olp_a%2Fb%2Bc`), so this proves each is redacted
    // independently rather than collapsing to one form.
    const cred = buildGitCredential('olp_a/b+c');
    expect(cred.sensitive[0]).not.toBe(cred.sensitive[1]);
    const leaked = `fatal: auth failed for git:${cred.sensitive[1]} (olp_a/b+c)`;
    const redacted = redactSensitive(leaked, cred.sensitive);
    expect(redacted).not.toContain('olp_a/b+c');
    expect(redacted).not.toContain('olp_a%2Fb%2Bc');
    expect(redacted).toContain('***');
  });
});
