// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import {
  createExternalLocation as externalLocation,
  createWorkspaceLocation,
} from '@texra-ai/harness/host';
import { replaceInputCommands } from '@texra/agent/output/fileMapping';
import { noopTrace } from '@test/support/noopTrace';

describe('replaceInputCommands', () => {
  it.effect(
    'keeps each \\input on its own base when two bases share a file name',
    () =>
      Effect.gen(function* () {
        const bases = [
          'paper.tex',
          'a/main.tex',
          'b/main.tex',
          'c/intro.tex',
        ].map((file) => createWorkspaceLocation(`/w/${file}`, file));
        // Outputs sit at the model-reported source path under the round dir;
        // the last one was renamed by the model.
        const outputs = [
          'paper.tex',
          'a/main.tex',
          'b/main.tex',
          'c/intro_revised.tex',
        ].map((source) => ({
          source,
          location: externalLocation(`/r/r1/${source}`),
        }));
        const original = String.raw`\input{a/main} \input{b/main} \input{c/intro}`;
        const files = new Map<string, string>(
          outputs.map(({ location }) => [location.absolutePath, original]),
        );

        yield* replaceInputCommands(bases, outputs, noopTrace).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFile: (target: string) =>
                Effect.succeed(
                  new TextEncoder().encode(files.get(target) ?? ''),
                ),
              writeFileString: (target: string, content: string) =>
                Effect.sync(() => {
                  files.set(target, content);
                }),
            }),
          ),
        );

        expect(files.get('/r/r1/paper.tex')).toBe(
          String.raw`\input{a/main} \input{b/main} \input{c/intro_revised}`,
        );
      }),
  );

  it.effect(
    'rewrites what LaTeX reads as an input: \\include and a spaced \\input, not a comment',
    () =>
      Effect.gen(function* () {
        const bases = ['paper.tex', 'intro.tex'].map((file) =>
          createWorkspaceLocation(`/w/${file}`, file),
        );
        const outputs = ['paper.tex', 'intro_revised.tex'].map((source) => ({
          source,
          location: externalLocation(`/r/r1/${source}`),
        }));
        const files = new Map<string, string>([
          [
            '/r/r1/paper.tex',
            String.raw`\include{intro}
\input {intro}
% \input{intro}`,
          ],
        ]);

        yield* replaceInputCommands(bases, outputs, noopTrace).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFile: (target: string) =>
                Effect.succeed(
                  new TextEncoder().encode(files.get(target) ?? ''),
                ),
              writeFileString: (target: string, content: string) =>
                Effect.sync(() => {
                  files.set(target, content);
                }),
            }),
          ),
        );

        expect(files.get('/r/r1/paper.tex')).toBe(
          String.raw`\include{intro_revised}
\input{intro_revised}
% \input{intro}`,
        );
      }),
  );
});
