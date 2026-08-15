import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getWorkspacePathInput,
  hasResolvedWorkspacePath,
  serializeWorkspacePresenceArg,
  withWorkspacePathArg,
} from '@desktop/shared/workspacePath';
import { resolveWorkspacePath } from '@desktop/main/platform/paths';
import { withTempDir } from '@test/support/tempDirPlatform';

describe('desktop workspace path', () => {
  it('resolves CLI workspace path before stored workspace', () => {
    expect(
      resolveWorkspacePath({
        argv: ['--texra-workspace-path', 'cli-workspace'],
        storedWorkspacePath: 'stored-workspace',
      }),
    ).toBe(resolve('cli-workspace'));
  });

  it('restores the last desktop-opened workspace when the CLI flag is absent', () => {
    expect(
      resolveWorkspacePath({
        argv: [],
        storedWorkspacePath: 'stored-workspace',
      }),
    ).toBe(resolve('stored-workspace'));
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
      getWorkspacePathInput({ argv: ['--texra-workspace-path'] }),
    ).toBeUndefined();
    expect(
      getWorkspacePathInput({ argv: ['--texra-workspace-path='] }),
    ).toBeUndefined();
    expect(
      getWorkspacePathInput({ argv: ['--texra-workspace-path', 'paper'] }),
    ).toBe('paper');
  });

  it('does not treat option-like positional workspace values as paths', () => {
    const argv = ['--texra-workspace-path', '--inspect'];

    expect(getWorkspacePathInput({ argv })).toBeUndefined();
    expect(resolveWorkspacePath({ argv })).toBeUndefined();
  });

  it.each([
    { argv: ['--texra-workspace-path', 'texra://auth-callback?code=1'] },
    { argv: ['--texra-workspace-path=texra://auth-callback?code=1'] },
  ])(
    'does not treat desktop protocol callback args $argv as workspace paths',
    ({ argv }) => {
      expect(getWorkspacePathInput({ argv })).toBeUndefined();
      expect(resolveWorkspacePath({ argv })).toBeUndefined();
    },
  );

  it('uses main-process workspace resolution when exposing renderer state', () => {
    expect(
      hasResolvedWorkspacePath({
        argv: [serializeWorkspacePresenceArg(true)],
      }),
    ).toBe(true);
    expect(
      hasResolvedWorkspacePath({
        argv: [
          '--texra-workspace-path',
          'renderer-process-argv-is-not-authoritative',
          serializeWorkspacePresenceArg(false),
        ],
      }),
    ).toBe(false);
  });

  it('replaces existing workspace CLI args when relaunching into a selected folder', () => {
    expect(
      withWorkspacePathArg(
        [
          '/Applications/TeXRA.app',
          '--inspect',
          '--texra-workspace-path',
          'old-workspace',
          '--flag',
          'texra://texra-ai.texra/auth-callback?state=old',
          '--texra-workspace-path=/tmp/stale-workspace',
        ],
        '/Users/ray/paper',
      ),
    ).toEqual([
      '/Applications/TeXRA.app',
      '--inspect',
      '--flag',
      '--texra-workspace-path=/Users/ray/paper',
    ]);
  });
});
