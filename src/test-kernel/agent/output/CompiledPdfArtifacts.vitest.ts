// Node imports
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { publishCompiledPdfArtifact } from '@agent/output/compiledPdfArtifacts';
import type { RunId } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  makeTempDir as makeSharedTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  createExternalLocation,
  createRunStorageLocation,
} from '@utils/files/fileLocation';

/**
 * Run `program` against the real filesystem service with a few members
 * replaced, so a failure the real disk will not produce on demand (a denied
 * stat, a denied delete) can still be pinned.
 */
function withFsOverrides<A, E>(
  overrides: Partial<FileSystem.FileSystem>,
  program: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* program.pipe(
      Effect.provideService(FileSystem.FileSystem, { ...fs, ...overrides }),
    );
  });
}

/** A platform failure with the given normalized reason tag. */
function platformFailure(
  tag: 'NotFound' | 'PermissionDenied',
  method: string,
): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: tag,
    module: 'FileSystem',
    method,
    description: `${method} ${tag}`,
  });
}

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

function externalSource(
  runDirectory: string,
  relativePath: string,
): ReturnType<typeof createExternalLocation> {
  return createExternalLocation(path.join(runDirectory, relativePath));
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.live('treats a missing compiled PDF as no artifact', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);

      const artifact = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'missing123' as RunId,
        round: 1,
        displayName: 'missing.tex',
        source: externalSource(runDirectory, 'missing.tex'),
        compiledPdfPath: path.join(runDirectory, 'missing.pdf'),
      });

      expect(artifact).toBeNull();
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('propagates unexpected compiled PDF stat failures', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const statError = platformFailure('PermissionDenied', 'stat');

      const failure = yield* Effect.flip(
        withFsOverrides(
          { stat: () => Effect.fail(statError) },
          publishCompiledPdfArtifact({
            runDirectory,
            runId: 'stat123' as RunId,
            round: 1,
            displayName: 'paper.tex',
            source: externalSource(runDirectory, 'paper.tex'),
            compiledPdfPath: path.join(runDirectory, 'paper.pdf'),
          }),
        ),
      );

      expect(failure).toBe(statError);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('continues when destination cleanup reports file not found', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const compiledPdfPath = path.join(runDirectory, 'build', 'paper.pdf');
      yield* Effect.promise(() => writePdf(compiledPdfPath, 'pdf bytes'));

      const artifact = yield* withFsOverrides(
        { remove: () => Effect.fail(platformFailure('NotFound', 'remove')) },
        publishCompiledPdfArtifact({
          runDirectory,
          runId: 'delete-missing123' as RunId,
          round: 1,
          displayName: 'paper.tex',
          source: externalSource(runDirectory, 'paper.tex'),
          compiledPdfPath,
        }),
      );

      expect(artifact).not.toBeNull();
      expect(
        yield* Effect.promise(() =>
          readOutput(runDirectory, 'r1', 'paper.pdf'),
        ),
      ).toBe('pdf bytes');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('propagates unexpected destination cleanup failures', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const compiledPdfPath = path.join(runDirectory, 'build', 'paper.pdf');
      const deleteError = platformFailure('PermissionDenied', 'remove');
      yield* Effect.promise(() => writePdf(compiledPdfPath, 'pdf bytes'));

      const failure = yield* Effect.flip(
        withFsOverrides(
          { remove: () => Effect.fail(deleteError) },
          publishCompiledPdfArtifact({
            runDirectory,
            runId: 'delete123' as RunId,
            round: 1,
            displayName: 'paper.tex',
            source: externalSource(runDirectory, 'paper.tex'),
            compiledPdfPath,
          }),
        ),
      );

      expect(failure).toBe(deleteError);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('publishes per-round and latest stable PDF paths', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const buildDir = path.join(
        runDirectory,
        'compile',
        'build',
        'r2',
        'paper',
      );
      const compiledPdfPath = path.join(buildDir, 'paper.pdf');
      yield* Effect.promise(() => writePdf(compiledPdfPath, 'pdf bytes'));

      const artifact = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'abc123' as RunId,
        round: 2,
        displayName: 'paper.tex',
        source: externalSource(runDirectory, path.join('r2', 'paper.tex')),
        compiledPdfPath,
      });

      expect(artifact?.relativePath).toBe('output/latest/paper.pdf');
      expect(
        yield* Effect.promise(() =>
          readOutput(runDirectory, 'r2', 'paper.pdf'),
        ),
      ).toBe('pdf bytes');
      expect(
        yield* Effect.promise(() =>
          readOutput(runDirectory, 'latest', 'paper.pdf'),
        ),
      ).toBe('pdf bytes');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('derives diff PDF names from the same source path rule', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const buildDir = path.join(runDirectory, 'diff', 'r4', 'build');
      const compiledPdfPath = path.join(buildDir, 'latexdiff-output.pdf');
      yield* Effect.promise(() => writePdf(compiledPdfPath, 'diff pdf'));

      const artifact = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'suffix123' as RunId,
        round: 4,
        displayName: 'latexdiff-output.tex',
        source: runStorageSource(
          runDirectory,
          path.join('r4', 'sections', 'main.tex'),
          'suffix123' as RunId,
        ),
        compiledPdfPath,
        pdfStemSuffix: '-diff',
      });

      expect(artifact?.relativePath).toBe(
        'output/latest/sections/main-diff.pdf',
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('strips a Windows-style round prefix without duplicating it', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const compiledPdfPath = path.join(runDirectory, 'build', 'main.pdf');
      yield* Effect.promise(() => writePdf(compiledPdfPath, 'diff pdf'));

      const artifact = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'windows123' as RunId,
        round: 4,
        displayName: 'main.tex',
        source: createRunStorageLocation(
          path.join(runDirectory, 'r4', 'sections', 'main.tex'),
          'r4\\sections\\main.tex',
          'windows123' as RunId,
        ),
        compiledPdfPath,
        pdfStemSuffix: '-diff',
      });

      expect(artifact?.relativePath).toBe(
        'output/latest/sections/main-diff.pdf',
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('keeps distinct diff kinds for the same revised source', () =>
    Effect.gen(function* () {
      const runDirectory = yield* Effect.promise(makeTempDir);
      const buildDir = path.join(runDirectory, 'diff', 'r5', 'build');
      const baseDiffPdfPath = path.join(buildDir, 'base.pdf');
      const roundDiffPdfPath = path.join(buildDir, 'round.pdf');
      const source = runStorageSource(
        runDirectory,
        path.join('r5', 'sections', 'main.tex'),
        'kind123' as RunId,
      );
      yield* Effect.promise(() => writePdf(baseDiffPdfPath, 'base diff'));
      yield* Effect.promise(() => writePdf(roundDiffPdfPath, 'round diff'));

      const baseDiff = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'kind123' as RunId,
        round: 5,
        displayName: 'base-diff.tex',
        source,
        compiledPdfPath: baseDiffPdfPath,
        pdfStemSuffix: '-diff',
      });
      const roundDiff = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId: 'kind123' as RunId,
        round: 5,
        displayName: 'round-diff.tex',
        source,
        compiledPdfPath: roundDiffPdfPath,
        pdfStemSuffix: '-round-diff',
      });

      expect(baseDiff?.relativePath).toBe(
        'output/latest/sections/main-diff.pdf',
      );
      expect(roundDiff?.relativePath).toBe(
        'output/latest/sections/main-round-diff.pdf',
      );
      expect(
        yield* Effect.promise(() =>
          readOutput(runDirectory, 'r5', 'sections', 'main-diff.pdf'),
        ),
      ).toBe('base diff');
      expect(
        yield* Effect.promise(() =>
          readOutput(runDirectory, 'r5', 'sections', 'main-round-diff.pdf'),
        ),
      ).toBe('round diff');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

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
