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

        yield* replaceInputCommands(bases, outputs).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFileString: (target: string) =>
                Effect.succeed(files.get(target) ?? ''),
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
});
