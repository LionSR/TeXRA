// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import {
  createFileMapping,
  replaceInputCommands,
} from '@agent/output/fileMapping';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { createExternalLocation as externalLocation } from '@utils/files/fileLocation';

/**
 * Run `program` against the real filesystem service with a few members
 * replaced, so a read and a write that fail without touching a real file can
 * still be pinned at the filesystem seam.
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFileMapping', () => {
  it('resolves a basename collision to the first source file', () => {
    const firstSource = externalLocation('/workspace/chapters/results.tex');
    const secondSource = externalLocation('/workspace/appendix/results.tex');
    const target = externalLocation('/run/r1/results.tex');

    const mapping = createFileMapping(
      [firstSource, secondSource],
      [target],
      'basename',
    );

    expect([...mapping.entries()]).toEqual([
      [firstSource.absolutePath, target],
    ]);
  });
});

describe('replaceInputCommands', () => {
  it.effect('rewrites an extensionless LaTeX input to the generated file', () =>
    Effect.gen(function* () {
      const baseMain = externalLocation('/workspace/main.tex');
      const baseSection = externalLocation('/workspace/sections/method.tex');
      const outputMain = externalLocation('/run/main_r1.tex');
      const outputSection = externalLocation('/run/sections/method_r1.tex');
      const read = vi.fn((target: string) =>
        Effect.succeed(
          target === outputMain.absolutePath
            ? String.raw`\input{sections/method}`
            : 'Section content',
        ),
      );
      const write = vi.fn(() => Effect.void);

      yield* withFsOverrides(
        { readFileString: read, writeFileString: write },
        replaceInputCommands(
          [baseMain, baseSection],
          [outputMain, outputSection],
        ),
      );

      expect(read).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith(
        outputMain.absolutePath,
        String.raw`\input{sections/method_r1}`,
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
