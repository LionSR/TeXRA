import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect } from 'vitest';

import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { GrepTool } from '@tools/grep';

layer(SessionGraph.hosted)('GrepTool run', (it) => {
  it.layer(FakeHost.layer({ workspaceRoot: process.cwd() }), {
    buildPerTest: true,
  })((it) => {
    it.effect(
      'preserves total-count and offset/head_limit pagination semantics',
      () =>
        Effect.gen(function* () {
          const result = yield* GrepTool.call({
            pattern: 'item',
            output_mode: 'content',
            offset: 1,
            head_limit: 2,
          });

          expect(result.output).toBe(
            'two\nthree\n\n[Showing 2 of 4 results. Use offset=3 to see more.]',
          );
        }).pipe(
          Effect.provide(
            Layer.merge(
              nativeToolTestLayer(),
              // ripgrep's output, read through `executeCommand`'s pipes.
              scriptedSpawnerLayer(() => ({
                stdout: 'one\n\ntwo\nthree\nfour\n',
              })).layer,
            ),
          ),
        ),
    );
  });
});
