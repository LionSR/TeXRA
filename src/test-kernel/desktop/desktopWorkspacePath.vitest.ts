import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseWorkspacePathFromArgv } from '@desktop/shared/workspacePath';
import { resolveWorkspacePath } from '@desktop/main/platform/paths';
import { withTempDir } from '@test/support/tempDirPlatform';

describe('desktop workspace path', () => {
  it('opens the folder named on the command line', () => {
    expect(
      resolveWorkspacePath({
        argv: ['--texra-workspace-path', 'cli-workspace'],
      }),
    ).toBe(resolve('cli-workspace'));
    expect(resolveWorkspacePath({ argv: [] })).toBeUndefined();
  });

  it('uses the physical path for a symlinked workspace', async () => {
    await withTempDir('texra-desktop-workspace-', async (root) => {
      const target = join(root, 'target');
      const link = join(root, 'link');
      await mkdir(target);
      await symlink(target, link, 'dir');

      expect(
        await realpath(
          resolveWorkspacePath({ argv: ['--texra-workspace-path', link] })!,
        ),
      ).toBe(await realpath(target));
    });
  });

  it('does not treat empty workspace flags as an opened workspace', () => {
    expect(
      parseWorkspacePathFromArgv(['--texra-workspace-path']),
    ).toBeUndefined();
    expect(
      parseWorkspacePathFromArgv(['--texra-workspace-path=']),
    ).toBeUndefined();
    expect(
      parseWorkspacePathFromArgv(['--texra-workspace-path', 'paper']),
    ).toBe('paper');
  });

  it('does not treat option-like positional workspace values as paths', () => {
    const argv = ['--texra-workspace-path', '--inspect'];

    expect(parseWorkspacePathFromArgv(argv)).toBeUndefined();
    expect(resolveWorkspacePath({ argv })).toBeUndefined();
  });

  it.each([
    { argv: ['--texra-workspace-path', 'texra://auth-callback?code=1'] },
    { argv: ['--texra-workspace-path=texra://auth-callback?code=1'] },
  ])(
    'does not treat desktop protocol callback args $argv as workspace paths',
    ({ argv }) => {
      expect(parseWorkspacePathFromArgv(argv)).toBeUndefined();
      expect(resolveWorkspacePath({ argv })).toBeUndefined();
    },
  );
});
