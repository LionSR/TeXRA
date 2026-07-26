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
  it('rejects paths outside the working directory by default', async () => {
    await installPlatform({ workspacePath: '/workspace' });

    expect(() =>
      resolveWorkspaceRelativePath('/outside/file.tex', '/workspace'),
    ).toThrow('Path must stay within the working directory.');
  });

  it('allows absolute and parent-relative paths when protection is disabled', async () => {
    await installPlatform({
      workspacePath: '/workspace',
      workspaceState: {
        [WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED]: false,
      },
    });

    expect(
      resolveWorkspaceRelativePath('/outside/file.tex', '/workspace'),
    ).toEqual({
      relative: '/outside/file.tex',
      absolute: '/outside/file.tex',
      fsPath: '/outside/file.tex',
    });
    expect(
      resolveWorkspaceRelativePath('../outside/file.tex', '/workspace'),
    ).toEqual({
      relative: '/outside/file.tex',
      absolute: '/outside/file.tex',
      fsPath: '/outside/file.tex',
    });
  });
});
