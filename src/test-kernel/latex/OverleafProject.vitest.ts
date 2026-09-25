import { describe, expect, it } from 'vitest';

import {
  overleafGitClone,
  overleafTokenSpec,
  parseLatexGitUrl,
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

describe('overleafGitClone', () => {
  it('clones a tokenless remote and hands the token to git out of band', () => {
    const clone = overleafGitClone(OVERLEAF_REMOTE, 'olp_a/b+c');
    // The recorded remote and every argument are free of the token; only
    // the helper's environment and the approval input carry it.
    expect(clone.args.slice(-3)).toEqual([
      'clone',
      `https://git@git.overleaf.com/${ID}`,
      '.',
    ]);
    expect(clone.args.join(' ')).not.toContain('olp_');
    expect(clone.env).toEqual({ TEXRA_GIT_TOKEN: 'olp_a/b+c' });
    expect(clone.approval).toBe(
      'protocol=https\nhost=git.overleaf.com\nusername=git\npassword=olp_a/b+c\n\n',
    );
  });
});
