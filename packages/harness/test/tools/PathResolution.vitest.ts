import * as path from 'node:path';
import { Effect } from 'effect';
import { it, layer } from '@effect/vitest';

import { describe, expect } from 'vitest';

import {
  assertNoParentTraversal,
  resolveToolPath,
  ToolError,
} from '@texra-ai/worldline/plugins';
import { FakeHost } from '@test/support/testKernel';
import { assertWritable } from '@tools/pathResolution';
import { canonicalizePath } from '@utils/files/externalRoots';

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

const workspaceRoot = path.resolve(path.sep, 'workspace');

layer(FakeHost.layer({ workspaceRoot }), { buildPerTest: true })(
  'resolveToolPath path protection',
  (it) => {
    it.effect(
      'keeps a read-only step root that sits inside the workspace non-writable',
      () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          const skill = path.join(workspaceRoot, '.texra', 'skills', 'proof');
          const stepRoots = [
            { absolutePath: canonicalizePath(skill), label: 'Skill proof' },
          ];

          const targetPath = '.texra/skills/proof/SKILL.md';
          const resolved = yield* resolveToolPath(
            { roots, stepRoots },
            targetPath,
          );

          expect(resolved.external?.writable).toBe(false);
          expect(
            yield* Effect.flip(assertWritable(resolved, targetPath)),
          ).toEqual(
            new ToolError(
              `Cannot write ${targetPath}: Skill proof is read-only.`,
            ),
          );
        }),
    );
  },
);
