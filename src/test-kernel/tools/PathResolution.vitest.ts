import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolError } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import {
  assertNoParentTraversal,
  assertWritable,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';
import { registerExternalRoot } from '@utils/files/externalRoots';

describe('assertNoParentTraversal', () => {
  it.each(['../x', 'a/../../x'])('rejects %s', (targetPath) => {
    expect(() => assertNoParentTraversal(targetPath)).toThrowError(
      new ToolError(`path must not contain '..': ${targetPath}`),
    );
  });

  it.each(['a/b', 'a..b'])('accepts %s', (targetPath) => {
    expect(() => assertNoParentTraversal(targetPath)).not.toThrow();
  });
});

describe('resolveWorkspaceRelativePath path protection', () => {
  const workspacePath = path.resolve(path.sep, 'workspace');
  const outsidePath = path.resolve(path.sep, 'outside', 'file.tex');
  it('rejects paths outside the working directory by default', async () => {
    await installPlatform({ workspacePath });

    expect(() =>
      resolveWorkspaceRelativePath(outsidePath, workspacePath),
    ).toThrow('Path must stay within the working directory.');
  });

  it('allows absolute and parent-relative paths when protection is disabled', async () => {
    await installPlatform({
      workspacePath,
      workspaceState: {
        [WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED]: false,
      },
    });

    const logicalOutsidePath = outsidePath.replaceAll('\\', '/');
    expect(resolveWorkspaceRelativePath(outsidePath, workspacePath)).toEqual({
      relative: logicalOutsidePath,
      absolute: outsidePath,
      fsPath: outsidePath,
    });
    expect(
      resolveWorkspaceRelativePath('../outside/file.tex', workspacePath),
    ).toEqual({
      relative: logicalOutsidePath,
      absolute: outsidePath,
      fsPath: outsidePath,
    });
  });

  // Last in the file on purpose: the registry has no unregister, so the
  // registration lives until the module registry is torn down with the file.
  it('keeps a read-only external root that sits inside the workspace non-writable', async () => {
    await installPlatform({ workspacePath });
    const packagedAgents = path.join(
      workspacePath,
      'packages',
      'extension',
      'resources',
      'agents',
    );
    registerExternalRoot(packagedAgents, {
      kind: 'builtInToolUse',
      writable: false,
      label: 'Packaged agents',
    });

    const targetPath = 'packages/extension/resources/agents/proof.yaml';
    const resolved = resolveWorkspaceRelativePath(targetPath);

    expect(resolved.external?.writable).toBe(false);
    expect(() => assertWritable(resolved, targetPath)).toThrowError(
      new ToolError(
        `Cannot write ${targetPath}: Packaged agents is read-only.`,
      ),
    );
  });
});
