import { describe, expect, it } from 'vitest';

import { overleafGitClone } from '@latex/overleafProject';

const ID = '0123456789abcdef01234567';

const OVERLEAF_REMOTE = {
  host: 'git.overleaf.com',
  path: `/${ID}`,
  isOverleaf: true,
};

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
