import { describe, expect, it } from 'vitest';

import {
  buildAuthenticatedRemoteUrl,
  buildGitCredential,
  overleafTokenSpec,
  parseLatexGitUrl,
  redactSensitive,
} from '@latex/overleafProject';

const ID = '0123456789abcdef01234567';

describe('parseLatexGitUrl', () => {
  it('parses a bare 24-char project id as Overleaf', () => {
    expect(parseLatexGitUrl(`  ${ID}  `)).toEqual({
      host: 'git.overleaf.com',
      path: `/${ID}`,
      isOverleaf: true,
    });
  });

  it('parses an Overleaf git URL', () => {
    expect(parseLatexGitUrl(`https://git.overleaf.com/${ID}`)).toEqual({
      host: 'git.overleaf.com',
      path: `/${ID}`,
      isOverleaf: true,
    });
  });

  it('parses a self-hosted ShareLaTeX git URL with /git and git@ userinfo', () => {
    expect(
      parseLatexGitUrl(`https://git@sharelatex.example.com/git/${ID}`),
    ).toEqual({
      host: 'sharelatex.example.com',
      path: `/git/${ID}`,
      isOverleaf: false,
    });
  });

  it('normalizes a www. Overleaf project URL to the git host', () => {
    expect(parseLatexGitUrl(`https://www.overleaf.com/project/${ID}`)).toEqual({
      host: 'git.overleaf.com',
      path: `/${ID}`,
      isOverleaf: true,
    });
  });

  it('routes a self-hosted project URL through /git', () => {
    expect(
      parseLatexGitUrl(`https://sharelatex.example.com/project/${ID}/`),
    ).toEqual({
      host: 'sharelatex.example.com',
      path: `/git/${ID}`,
      isOverleaf: false,
    });
  });

  it('returns null for unrecognized input', () => {
    expect(parseLatexGitUrl('not-a-url')).toBeNull();
    expect(parseLatexGitUrl('https://example.com/project/short')).toBeNull();
  });
});

describe('overleafTokenSpec', () => {
  it('requires an olp_ prefix for Overleaf', () => {
    const spec = overleafTokenSpec({
      host: 'git.overleaf.com',
      path: `/${ID}`,
      isOverleaf: true,
    });
    expect(spec.tokenKey).toBe('overleaf.gitToken');
    expect(spec.tokenValidator?.('olp_abc')).toBe(true);
    expect(spec.tokenValidator?.('nope')).toBe(false);
  });

  it('namespaces the token key by host and skips validation for ShareLaTeX', () => {
    const spec = overleafTokenSpec({
      host: 'sharelatex.example.com',
      path: `/git/${ID}`,
      isOverleaf: false,
    });
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
    const remote = {
      host: 'git.overleaf.com',
      path: `/${ID}`,
      isOverleaf: true,
    };
    expect(
      buildAuthenticatedRemoteUrl(remote, buildGitCredential('olp_x')),
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
