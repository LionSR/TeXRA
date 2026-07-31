import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  hasResolvedWorkspacePath,
  hasWorkspacePath,
  serializeWorkspacePresenceArg,
  withWorkspacePathArg,
} from '@desktop/workspacePath';
import { resolveWorkspacePath } from '@desktop/main/platform/paths';

describe('desktop workspace path', () => {
  it('resolves CLI workspace path before env and stored workspace', () => {
    expect(
      resolveWorkspacePath({
        argv: ['--texra-workspace', 'cli-workspace'],
        env: { TEXRA_WORKSPACE_PATH: 'env-workspace' },
        storedWorkspacePath: 'stored-workspace',
      }),
    ).toBe(resolve('cli-workspace'));
  });

  it('resolves env workspace before stored workspace', () => {
    expect(
      resolveWorkspacePath({
        argv: [],
        env: { TEXRA_WORKSPACE_PATH: 'env-workspace' },
        storedWorkspacePath: 'stored-workspace',
      }),
    ).toBe(resolve('env-workspace'));
  });

  it('restores the last desktop-opened workspace when CLI and env are absent', () => {
    expect(
      resolveWorkspacePath({
        argv: [],
        env: {},
        storedWorkspacePath: 'stored-workspace',
      }),
    ).toBe(resolve('stored-workspace'));
    expect(
      resolveWorkspacePath({
        argv: [],
        env: {},
      }),
    ).toBeUndefined();
  });

  it('uses the physical path for a symlinked workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-desktop-workspace-'));
    try {
      const target = join(root, 'target');
      const link = join(root, 'link');
      await mkdir(target);
      await symlink(target, link, 'dir');

      expect(
        resolveWorkspacePath({
          argv: ['--texra-workspace', link],
          env: {},
        }),
      ).toBe(await realpath(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat empty workspace flags as an opened workspace', () => {
    expect(hasWorkspacePath({ argv: ['--texra-workspace'], env: {} })).toBe(
      false,
    );
    expect(hasWorkspacePath({ argv: ['--texra-workspace='], env: {} })).toBe(
      false,
    );
    expect(
      hasWorkspacePath({ argv: ['--texra-workspace', 'paper'], env: {} }),
    ).toBe(true);
  });

  it('does not treat option-like positional workspace values as paths', () => {
    expect(
      hasWorkspacePath({ argv: ['--texra-workspace', '--inspect'], env: {} }),
    ).toBe(false);
    expect(
      resolveWorkspacePath({
        argv: ['--texra-workspace', '--inspect'],
        env: {},
      }),
    ).toBeUndefined();
  });

  it('does not treat desktop protocol callback URLs as workspace paths', () => {
    expect(
      hasWorkspacePath({
        argv: ['--texra-workspace', 'texra://auth-callback?code=1'],
        env: {},
      }),
    ).toBe(false);
    expect(
      resolveWorkspacePath({
        argv: ['--texra-workspace', 'texra://auth-callback?code=1'],
        env: {},
      }),
    ).toBeUndefined();
    expect(
      hasWorkspacePath({
        argv: ['--texra-workspace=texra://auth-callback?code=1'],
        env: {},
      }),
    ).toBe(false);
    expect(
      resolveWorkspacePath({
        argv: ['--texra-workspace=texra://auth-callback?code=1'],
        env: {},
      }),
    ).toBeUndefined();
  });

  it('uses main-process workspace resolution when exposing renderer state', () => {
    expect(
      hasResolvedWorkspacePath({
        argv: [serializeWorkspacePresenceArg(true)],
      }),
    ).toBe(true);
    expect(
      hasResolvedWorkspacePath({
        argv: [
          '--texra-workspace',
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
          '--texra-new-window',
          '--texra-workspace',
          'old-workspace',
          '--flag',
          'texra://texra-ai.texra/auth-callback?state=old',
          '--texra-workspace=/tmp/other-workspace',
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
