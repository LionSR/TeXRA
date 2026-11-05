// Node imports
import { readFile } from 'node:fs/promises';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect } from 'vitest';

// Local imports
import { approvedWriteConflict } from '@texra-ai/harness/plugins';
import { fakePath } from '@test/support/FakePlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { writeApprovedContent } from '@tools/approval/approvedWrite';

/** Install, for the test's scope, a host whose workspace holds `files`. */
const installFakePlatform = (files: Record<string, string> = {}) =>
  Layer.build(
    FakeHost.layer({
      files,
      storagePath: fakePath('workspace/.texra/storage'),
      workspacePath: fakePath('workspace'),
    }),
  );

layer(SessionGraph.hosted)('approved write', (it) => {
  it.effect(
    'applies an approved edit over unrelated concurrent changes and refuses conflicting ones',
    () =>
      Effect.gen(function* () {
        const original = 'alpha\nbeta\nomega\n';
        const final = 'alpha\nBETA\nomega\n';

        yield* installFakePlatform({
          '/workspace/paper.tex': 'alpha\nbeta\nomega\nlocal\n',
        });
        const writeResult = yield* writeApprovedContent(
          'paper.tex',
          original,
          final,
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );

        expect(writeResult).toEqual({
          appliedContent: 'alpha\nBETA\nomega\nlocal\n',
        });
        expect(
          yield* Effect.tryPromise(() =>
            readFile(fakePath('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('alpha\nBETA\nomega\nlocal\n');

        // A concurrent change to the approved hunk is a conflict, never an
        // overwrite of that change with the approved content.
        yield* installFakePlatform({
          '/workspace/paper.tex': 'rewritten\nby another\nwriter\n',
        });
        const conflict = yield* approvedWriteConflict(
          'paper.tex',
          original,
          final,
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );
        expect(conflict?.message).toContain('changed on disk');
        expect(
          yield* Effect.tryPromise(() =>
            readFile(fakePath('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('rewritten\nby another\nwriter\n');
      }),
  );
});
