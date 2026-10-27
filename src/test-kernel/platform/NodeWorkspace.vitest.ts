// Node imports
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - platform
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import {
  canonicalizeWorkspacePath,
  relativeToRoot,
} from '@utils/system/nodeWorkspace';

describe('Node workspace identity', () => {
  const tempDirs = useTempDirs();

  it('uses the physical directory for a symlinked workspace', async () => {
    const root = await makeTempDir('texra-node-workspace-', tempDirs);
    const target = join(root, 'target');
    const link = join(root, 'link');
    await mkdir(target);
    await symlink(target, link, 'dir');
    await writeFile(join(target, 'paper.tex'), 'content', 'utf8');

    const canonical = await realpath(link);
    expect(canonicalizeWorkspacePath(link)).toBe(canonical);
    expect(relativeToRoot(link, join(link, 'paper.tex'))).toBe('paper.tex');
    expect(relativeToRoot(link, join(link, 'new', 'draft.tex'))).toBe(
      'new/draft.tex',
    );
  });
});
