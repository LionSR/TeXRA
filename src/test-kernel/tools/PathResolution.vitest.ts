import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
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
  resolveToolPath,
} from '@tools/pathResolution';
import { toPosixPath } from '@utils/core/pathCore';
import { registerExternalRoot } from '@utils/files/externalRoots';

describe('assertNoParentTraversal', () => {
  it.effect.each(['../x', 'a/../../x'])('rejects %s', (targetPath) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(assertNoParentTraversal(targetPath));
      expect(error).toEqual(
        new ToolError(`path must not contain '..': ${targetPath}`),
      );
    }),
  );

  it.effect.each(['a/b', 'a..b'])('accepts %s', (targetPath) =>
    assertNoParentTraversal(targetPath),
  );
});

describe('resolveToolPath path protection', () => {
  const workspacePath = path.resolve(path.sep, 'workspace');
  const outsidePath = path.resolve(path.sep, 'outside', 'file.tex');

  it.effect('does not read path protection for a contained path', () =>
    Effect.gen(function* () {
      const { stores, workspaceState } = makeFakeSettingsStores();
      const resolved = yield* resolveToolPath(
        {
          roots: {
            workspace: workspacePath,
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
        },
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
          resolveToolPath(
            { roots: installedHost().roots, workingDirectory: workspacePath },
            outsidePath,
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
          yield* resolveToolPath(
            { roots, workingDirectory: workspacePath },
            outsidePath,
          ),
        ).toEqual({
          relative: logicalOutsidePath,
          absolute: outsidePath,
          fsPath: outsidePath,
          display: toPosixPath(logicalOutsidePath),
        });
        expect(
          yield* resolveToolPath(
            { roots, workingDirectory: workspacePath },
            '../outside/file.tex',
          ),
        ).toEqual({
          relative: logicalOutsidePath,
          absolute: outsidePath,
          fsPath: outsidePath,
          display: toPosixPath(logicalOutsidePath),
        });
      }),
  );

  it.effect.skipIf(process.platform === 'win32')(
    'rejects a path that leaves the workspace through a symlink inside it',
    () =>
      Effect.gen(function* () {
        // os.tmpdir() is itself a symlinked spelling on macOS (/var ->
        // /private/var), so this also pins that a non-canonical root spelling
        // does not make its own contents read as outside.
        const parent = mkdtempSync(path.join(os.tmpdir(), 'texra-escape-'));
        const workspace = path.join(parent, 'ws');
        mkdirSync(workspace);
        symlinkSync('..', path.join(workspace, 'up'));
        yield* Effect.promise(() =>
          installPlatform({ workspacePath: workspace }),
        );
        const call = { roots: { ...installedHost().roots, workspace } };

        const inside = yield* resolveToolPath(call, 'inside.tex');
        expect(inside.relative).toBe('inside.tex');
        const error = yield* Effect.flip(
          resolveToolPath(call, 'up/escaped.txt'),
        );
        expect(error.message).toMatch(
          /^Path must stay within the workspace\. up\/escaped\.txt resolves through a symlink to .*\/escaped\.txt\.$/,
        );
        rmSync(parent, { recursive: true, force: true });
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
        const resolved = yield* resolveToolPath(
          { roots: installedHost().roots },
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
