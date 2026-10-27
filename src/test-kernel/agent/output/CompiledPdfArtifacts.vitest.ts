// Node imports
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import type { RunId } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { publishCompiledPdfArtifact } from '@texra/agent/output/compiledPdfArtifacts';
import { createRunStorageLocation } from '@utils/files/fileLocation';

describe('compiled PDF artifacts', () => {
  const tempDirs = useTempDirs();

  setupPlatform({});

  it.live('preserves source subdirectories for duplicate basenames', () =>
    Effect.gen(function* () {
      const runId = 'dup123' as RunId;
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
});
