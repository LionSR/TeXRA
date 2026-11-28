// The `write-up` program's own checks, run as its run runs them: the
// program's modules in the script sandbox, over files a stand-in child
// writes.
//
// The failure modes this suite guards:
// - the writer states a weaker claim than the one it was given, and the
//   program answers as if the note stated the claim;
// - the writer edits a working file it was only to read;
// - a note that states the claim with different line breaks is reported as
//   changed.

import * as NodeWorker from '@effect/platform-node/NodeWorker';
import { layer } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { expect } from 'vitest';

import { CodeSandbox } from '@agent/codeSandbox/codeSandbox';
import { SessionGraph } from '@test/support/testKernel';
import { THEORY_MODULES } from '@texra/tools/theory/programs';

const CLAIM =
  'For every $n \\ge 1$,\nthe sum of the first $n$ odd numbers is $n^2$.';
const WORK = 'Induction on $n$; the step adds $2n+1$.';

const ReadInput = Schema.Struct({ path: Schema.String });

/** Run `write-up` over an in-memory project; `write` is what the child
 *  does to it. */
const writeUp = (write: (files: Map<string, string>) => void) =>
  Effect.gen(function* () {
    const files = new Map([
      ['claim.tex', CLAIM],
      ['work.md', WORK],
    ]);
    const result = yield* (yield* CodeSandbox).run({
      source: `const { default: writeUp } = await import('builtIn:write-up');
return await writeUp({ claim: 'claim.tex', note: 'note.tex' }, { instruction: '', inputFiles: ['work.md'], contextFiles: [], mediaFiles: [] });`,
      tools: ['read_file'],
      globals: ['agent'],
      modules: Object.fromEntries(
        Object.entries(THEORY_MODULES).map(([name, module]) => [
          `builtIn:${name}`,
          module,
        ]),
      ),
      timeout: '20 seconds',
      call: (op) =>
        Effect.sync(() => {
          if (op.name === 'agent()') {
            write(files);
            return { _tag: 'Value' as const, value: { response: 'Written.' } };
          }
          const text = files.get(
            Schema.decodeUnknownSync(ReadInput)(op.input).path,
          );
          return text === undefined
            ? {
                _tag: 'Failure' as const,
                name: 'ToolError',
                message: 'File not found',
              }
            : {
                _tag: 'Value' as const,
                value: {
                  output: text
                    .split('\n')
                    .map((line, index) => `${index + 1}\t${line}`)
                    .join('\n'),
                },
              };
        }),
    });
    return String(result.value);
  });

layer(
  Layer.merge(
    SessionGraph.hosted,
    CodeSandbox.layer.pipe(Layer.provide(NodeWorker.layerPlatform)),
  ),
  { excludeTestServices: true },
)('the write-up program', (it) => {
  it.effect('a note that states the claim on other lines passes', () =>
    Effect.gen(function* () {
      const answer = yield* writeUp((files) =>
        files.set(
          'note.tex',
          `\\begin{theorem}\n  ${CLAIM.replace('\n', ' ')}\n\\end{theorem}`,
        ),
      );
      expect(answer).toBe('Written.');
    }),
  );

  it.effect('a weakened claim and an edited working file are reported', () =>
    Effect.gen(function* () {
      const answer = yield* writeUp((files) => {
        files.set('note.tex', CLAIM.replace('every $n \\ge 1$', 'large $n$'));
        files.set('work.md', `${WORK} Tidied.`);
      });
      expect(answer).toContain('note.tex does not state the claim');
      expect(answer).toContain('differ now: work.md');
    }),
  );

  it.effect('a note that was never written is reported', () =>
    Effect.gen(function* () {
      const answer = yield* writeUp(() => {});
      expect(answer).toContain('The note at note.tex cannot be read');
    }),
  );
});
