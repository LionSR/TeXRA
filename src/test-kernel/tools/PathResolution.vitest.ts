import * as path from 'node:path';
import { Effect } from 'effect';
import { it } from '@effect/vitest';

import { describe, expect } from 'vitest';

import { StateReadFailed } from '@platform/interfaces';
import { ToolError } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { installedHost, installPlatform } from '@test/support/setupPlatform';
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

  it.effect('does not read path protection for a contained path', () =>
    Effect.gen(function* () {
      const { stores, workspaceState } = makeFakeSettingsStores();
      const resolved = yield* resolveWorkspaceRelativePath(
        {
          ...stores,
          workspaceState: {
            get: (key) =>
              Effect.fail(
                new StateReadFailed({
                  key,
                  message: 'state unavailable',
                  cause: new Error('state unavailable'),
                }),
              ),
            update: (key, value) => workspaceState.update(key, value),
          },
        },
        workspacePath,
        'inside.tex',
      );

      expect(resolved.absolute).toBe(path.join(workspacePath, 'inside.tex'));
    }),
  );

  it.effect('rejects paths outside the working directory by default', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installPlatform({ workspacePath }));

      expect(
        yield* Effect.flip(
          resolveWorkspaceRelativePath(
            installedHost().roots,
            workspacePath,
            outsidePath,
            workspacePath,
          ),
        ),
      ).toMatchObject({
        message: 'Path must stay within the working directory.',
      });
    }),
  );

  it.effect(
    'allows absolute and parent-relative paths when protection is disabled',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            workspacePath,
            workspaceState: {
              [WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED]: false,
            },
          }),
        );

        const { roots } = installedHost();
        const logicalOutsidePath = outsidePath.replaceAll('\\', '/');
        expect(
          yield* resolveWorkspaceRelativePath(
            roots,
            workspacePath,
            outsidePath,
            workspacePath,
          ),
        ).toEqual({
          relative: logicalOutsidePath,
          absolute: outsidePath,
          fsPath: outsidePath,
        });
        expect(
          yield* resolveWorkspaceRelativePath(
            roots,
            workspacePath,
            '../outside/file.tex',
            workspacePath,
          ),
        ).toEqual({
          relative: logicalOutsidePath,
          absolute: outsidePath,
          fsPath: outsidePath,
        });
      }),
  );

  // Last in the file on purpose: the registry has no unregister, so the
  // registration lives until the module registry is torn down with the file.
  it.effect(
    'keeps a read-only external root that sits inside the workspace non-writable',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installPlatform({ workspacePath }));
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
        const resolved = yield* resolveWorkspaceRelativePath(
          installedHost().roots,
          workspacePath,
          targetPath,
        );

        expect(resolved.external?.writable).toBe(false);
        expect(() => assertWritable(resolved, targetPath)).toThrowError(
          new ToolError(
            `Cannot write ${targetPath}: Packaged agents is read-only.`,
          ),
        );
      }),
  );
});
