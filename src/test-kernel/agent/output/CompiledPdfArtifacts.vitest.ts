// Node imports
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

// Local imports
import { createRunStorageLocation } from '@texra-ai/harness/host';
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeHost } from '@test/support/testKernel';
import { publishCompiledPdfArtifact } from '@texra/agent/output/compiledPdfArtifacts';

layer(FakeHost.layer(), { excludeTestServices: true })(
  'compiled PDF artifacts',
  (it) => {
    const tempDirs = useTempDirs();

    it.effect('preserves source subdirectories for duplicate basenames', () =>
      Effect.gen(function* () {
        const runId = Schema.decodeUnknownSync(RunIdSchema)('dd0123');
        const runDirectory = yield* Effect.promise(() =>
          makeTempDir('texra-pdf-artifact-', tempDirs),
        );
        /** Compile `chapter`'s `main.tex` to a PDF holding `contents`, and
         *  publish it. */
        const publish = (chapter: string, contents: string) =>
          Effect.gen(function* () {
            const compiledPdfPath = path.join(
              runDirectory,
              'compile',
              'build',
              'r3',
              `${chapter}-main`,
              'main.pdf',
            );
            yield* Effect.promise(async () => {
              await mkdir(path.dirname(compiledPdfPath), { recursive: true });
              await writeFile(compiledPdfPath, contents);
            });
            const relativePath = path.join('r3', chapter, 'main.tex');
            return yield* publishCompiledPdfArtifact({
              runDirectory,
              runId,
              round: 3,
              displayName: 'main.tex',
              source: createRunStorageLocation(
                path.join(runDirectory, relativePath),
                relativePath,
                runId,
              ),
              compiledPdfPath,
            });
          });
        const readOutput = (chapter: string) =>
          Effect.promise(() =>
            readFile(
              path.join(runDirectory, 'output', 'r3', chapter, 'main.pdf'),
              'utf8',
            ),
          );

        const first = yield* publish('ch1', 'chapter 1');
        const second = yield* publish('ch2', 'chapter 2');

        expect(first?.relativePath).toBe('output/latest/ch1/main.pdf');
        expect(second?.relativePath).toBe('output/latest/ch2/main.pdf');
        expect(yield* readOutput('ch1')).toBe('chapter 1');
        expect(yield* readOutput('ch2')).toBe('chapter 2');
      }).pipe(Effect.provide(nodePlatformLayer)),
    );
  },
);
