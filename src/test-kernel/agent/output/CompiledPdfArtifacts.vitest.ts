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
import {
  makeTempDir as makeSharedTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { publishCompiledPdfArtifact } from '@texra/agent/output/compiledPdfArtifacts';
import { createRunStorageLocation } from '@utils/files/fileLocation';

async function writePdf(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function readOutput(
  runDirectory: string,
  ...segments: string[]
): Promise<string> {
  return readFile(path.join(runDirectory, 'output', ...segments), 'utf8');
}

function runStorageSource(
  runDirectory: string,
  relativePath: string,
  runId: RunId,
): ReturnType<typeof createRunStorageLocation> {
  return createRunStorageLocation(
    path.join(runDirectory, relativePath),
    relativePath,
    runId,
  );
}

describe('compiled PDF artifacts', () => {
  const tempDirs = useTempDirs();

  setupPlatform({});

  function makeTempDir(): Promise<string> {
    return makeSharedTempDir('texra-pdf-artifact-', tempDirs);
  }

  it.live('preserves source subdirectories for duplicate basenames', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const buildDir = path.join(runDirectory, 'compile', 'build', 'r3');
      const firstPdfPath = path.join(buildDir, 'ch1-main', 'main.pdf');
      const secondPdfPath = path.join(buildDir, 'ch2-main', 'main.pdf');
      yield* Effect.promise(() => writePdf(firstPdfPath, 'chapter 1'));
      yield* Effect.promise(() => writePdf(secondPdfPath, 'chapter 2'));

      const first = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'dup123' as RunId,
        round: 3,
        displayName: 'main.tex',
        source: runStorageSource(
          runDirectory,
          path.join('r3', 'ch1', 'main.tex'),
          'dup123' as RunId,
        ),
        compiledPdfPath: firstPdfPath,
      });
      const second = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'dup123' as RunId,
        round: 3,
        displayName: 'main.tex',
        source: runStorageSource(
          runDirectory,
          path.join('r3', 'ch2', 'main.tex'),
          'dup123' as RunId,
        ),
        compiledPdfPath: secondPdfPath,
      });

      expect(first?.relativePath).toBe('output/latest/ch1/main.pdf');
      expect(second?.relativePath).toBe('output/latest/ch2/main.pdf');
      expect(
        yield* Effect.promise(() =>
          readOutput(runDirectory, 'r3', 'ch1', 'main.pdf'),
        ),
      ).toBe('chapter 1');
      expect(
        yield* Effect.promise(() =>
          readOutput(runDirectory, 'r3', 'ch2', 'main.pdf'),
        ),
      ).toBe('chapter 2');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
