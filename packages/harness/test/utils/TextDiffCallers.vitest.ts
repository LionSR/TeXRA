// Node imports
import { readFile } from 'node:fs/promises';

// Third-party imports
import { layer } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { expect } from 'vitest';

// Local imports
import { approvedWriteConflict } from '@texra-ai/harness/plugins';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { writeApprovedContent } from '@tools/approval/approvedWrite';

/** A host for the test's scope whose workspace holds `files`, and a tool
 *  call's services over it. */
const fakeHostWith = (files: Record<string, string> = {}) =>
  Effect.map(Layer.build(FakeHost.layer({ files })), (context) => {
    const host = Context.get(context, FakeHost);
    return {
      host,
      tools: Layer.provide(
        nativeToolTestLayer({ workingDirectory: host.path('workspace') }),
        Layer.succeedContext(context),
      ),
    };
  });

layer(SessionGraph.hosted)('approved write', (it) => {
  it.effect(
    'applies an approved edit over unrelated concurrent changes and refuses conflicting ones',
    () =>
      Effect.gen(function* () {
        const original = 'alpha\nbeta\nomega\n';
        const final = 'alpha\nBETA\nomega\n';

        const first = yield* fakeHostWith({
          '/workspace/paper.tex': 'alpha\nbeta\nomega\nlocal\n',
        });
        const writeResult = yield* writeApprovedContent(
          'paper.tex',
          original,
          final,
        ).pipe(Effect.provide(first.tools));

        expect(writeResult).toEqual({
          appliedContent: 'alpha\nBETA\nomega\nlocal\n',
        });
        expect(
          yield* Effect.tryPromise(() =>
            readFile(first.host.path('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('alpha\nBETA\nomega\nlocal\n');

        // A concurrent change to the approved hunk is a conflict, never an
        // overwrite of that change with the approved content.
        const second = yield* fakeHostWith({
          '/workspace/paper.tex': 'rewritten\nby another\nwriter\n',
        });
        const conflict = yield* approvedWriteConflict(
          'paper.tex',
          original,
          final,
        ).pipe(Effect.provide(second.tools));
        expect(conflict?.message).toContain('changed on disk');
        expect(
          yield* Effect.tryPromise(() =>
            readFile(second.host.path('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('rewritten\nby another\nwriter\n');
      }),
  );
});
