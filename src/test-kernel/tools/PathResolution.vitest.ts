import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect } from 'effect';
import { it } from '@effect/vitest';

import { describe, expect } from 'vitest';

import { ToolError } from '@shared/schemas';
import { installedHost, installPlatform } from '@test/support/setupPlatform';
import {
  assertNoParentTraversal,
  assertWritable,
  resolveToolPath,
} from '@tools/pathResolution';
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
});

describe('resolveToolPath path protection', () => {
  const workspacePath = path.resolve(path.sep, 'workspace');
  const outsidePath = path.resolve(path.sep, 'outside', 'file.tex');

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
          kind: 'builtIn',
          writable: false,
          label: 'Packaged agents',
        });

        const targetPath = 'packages/extension/resources/agents/proof.yaml';
        const resolved = yield* resolveToolPath(
          { roots: installedHost().roots },
          targetPath,
        );

        expect(resolved.external?.writable).toBe(false);
        expect(
          yield* Effect.flip(assertWritable(resolved, targetPath)),
        ).toEqual(
          new ToolError(
            `Cannot write ${targetPath}: Packaged agents is read-only.`,
          ),
        );
      }),
  );
});
