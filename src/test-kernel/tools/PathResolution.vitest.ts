import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolError } from '@shared/schemas/toolResult';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import {
  assertNoParentTraversal,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';

describe('assertNoParentTraversal', () => {
  it.each(['../x', 'a/../../x'])('rejects %s', (targetPath) => {
    expect(() => assertNoParentTraversal(targetPath)).toThrow(ToolError);
    expect(() => assertNoParentTraversal(targetPath)).toThrow(
      `path must not contain '..': ${targetPath}`,
    );
  });

  it.each(['a/b', 'a..b'])('accepts %s', (targetPath) => {
    expect(() => assertNoParentTraversal(targetPath)).not.toThrow();
  });
});

describe('resolveWorkspaceRelativePath path protection', () => {
  const workspacePath = path.join(path.sep, 'workspace');
  const outsidePath = path.join(path.sep, 'outside', 'file.tex');
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

    expect(resolveWorkspaceRelativePath(outsidePath, workspacePath)).toEqual({
      relative: outsidePath,
      absolute: outsidePath,
      fsPath: outsidePath,
    });
    expect(
      resolveWorkspaceRelativePath('../outside/file.tex', workspacePath),
    ).toEqual({
      relative: outsidePath,
      absolute: outsidePath,
      fsPath: outsidePath,
    });
  });
});
