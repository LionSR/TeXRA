// Node imports
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - platform
import {
  canonicalizeWorkspacePath,
  createNodeWorkspace,
} from '@platform/defaults/nodeWorkspace';

describe('Node workspace identity', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('uses the physical directory for a symlinked workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-node-workspace-'));
    tempDirs.push(root);
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
    expect(canonicalizeWorkspacePath(missing)).toBe(
      join(await realpath(tmpdir()), basename(missing)),
    );
  });
});
