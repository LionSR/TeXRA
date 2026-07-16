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
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspacePath: undefined as string | undefined,
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return mocks.workspacePath
        ? [{ uri: { fsPath: mocks.workspacePath } }]
        : undefined;
    },
  },
}));

// Local imports - extension
import { VscodeWorkspace } from '@frontend/vscode/vscodeWorkspace';

describe('VscodeWorkspace', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mocks.workspacePath = undefined;
    await Promise.all(
      tempDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('uses one physical root for identity and relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-vscode-workspace-'));
    tempDirs.push(root);
    const target = join(root, 'target');
    const link = join(root, 'link');
    await mkdir(target);
    await symlink(target, link, 'dir');
    await writeFile(join(target, 'paper.tex'), 'content', 'utf8');
    mocks.workspacePath = link;

    const workspace = new VscodeWorkspace();
    const physicalRoot = await realpath(target);
    expect(workspace.getWorkspacePath()).toBe(physicalRoot);
    expect(workspace.getLegacyWorkspacePaths()).toEqual([link]);
    expect(workspace.asRelativePath(join(link, 'paper.tex'))).toBe('paper.tex');
    expect(workspace.asRelativePath(join(physicalRoot, 'paper.tex'))).toBe(
      'paper.tex',
    );
  });
});
