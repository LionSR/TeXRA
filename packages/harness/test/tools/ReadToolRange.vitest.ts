// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

// Local imports
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { ReadFileTool } from '@tools/ReadTool';

/** 10 lines: "line 1" … "line 10". */
const SMALL = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
const LARGE = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join(
  '\n',
);

const callRead = (input: unknown) =>
  Effect.flatMap(FakeHost, (host) =>
    ReadFileTool.call(input).pipe(
      Effect.provide(
        nativeToolTestLayer({ workingDirectory: host.path('workspace') }),
      ),
    ),
  );

const host = FakeHost.layer({
  files: {
    '/workspace/large.txt': LARGE,
    '/workspace/small.txt': SMALL,
  },
});

layer(SessionGraph.hosted)('read_file line ranges', (it) => {
  it.layer(host, { buildPerTest: true })((it) => {
    it.effect.each([
      {
        name: 'the array range form some models emit',
        range: [2, 4],
        summary: 'Read lines 2-4 of small.txt',
        contains: ['line 2', 'line 4'],
        excludes: ['line 5'],
      },
    ])('reads $name', ({ range, summary, contains, excludes }) =>
      Effect.gen(function* () {
        const result = yield* callRead({ path: 'small.txt', range });

        expect(result.summary).toBe(summary);
        for (const line of contains) expect(result.output).toContain(line);
        for (const line of excludes) expect(result.output).not.toContain(line);
      }),
    );

    it.effect(
      'reports remaining lines when a start-only range is truncated',
      () =>
        Effect.gen(function* () {
          const result = yield* callRead({
            path: 'large.txt',
            range: { start: 2 },
          });

          expect(result.summary).toBe('Read lines 2-2001 of large.txt');
          expect(result.output).toContain('...(truncated, 499 more lines)');
        }),
    );
  });
});
