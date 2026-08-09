// Node imports
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - platform
import {
  canonicalizeWorkspacePath,
  createNodeWorkspace,
} from '@platform/defaults/nodeWorkspace';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

describe('Node workspace identity', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('uses the physical directory for a symlinked workspace', async () => {
    const root = await makeTempDir('texra-node-workspace-', tempDirs);
    const target = join(root, 'target');
    const link = join(root, 'link');
    await mkdir(target);
    await symlink(target, link, 'dir');
    await writeFile(join(target, 'paper.tex'), 'content', 'utf8');

    const canonical = await realpath(link);
    expect(canonicalizeWorkspacePath(link)).toBe(canonical);
    const workspace = createNodeWorkspace(() => link);
    expect(workspace.getWorkspacePath()).toBe(canonical);
    expect(workspace.asRelativePath(join(link, 'paper.tex'))).toBe('paper.tex');
    expect(workspace.asRelativePath(join(link, 'new', 'draft.tex'))).toBe(
      'new/draft.tex',
    );
  });

  it('preserves a missing tail beneath its physical ancestor', async () => {
    const missing = join(tmpdir(), `texra-missing-${Date.now()}`);
    // Build the expected path from the same physical ancestor the implementation
    // resolves, including Windows 8.3 short-name behavior.
    expect(canonicalizeWorkspacePath(missing)).toBe(
      join(canonicalizeWorkspacePath(tmpdir()), basename(missing)),
    );
  });

  it('keeps a path through a child symlink relative to the workspace', async () => {
    const root = await makeTempDir('texra-child-link-workspace-', tempDirs);
    const outside = await makeTempDir('texra-child-link-target-', tempDirs);
    const link = join(root, 'linked');
    await symlink(outside, link, 'dir');

    const workspace = createNodeWorkspace(() => root);
    expect(workspace.asRelativePath(join(link, 'new.tex'))).toBe(
      'linked/new.tex',
    );
  });
});
