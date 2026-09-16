// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, FileSystem, PlatformError } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import {
  createFileMapping,
  replaceInputCommands,
} from '@agent/implementations/flows/reflection/output/fileMapping';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
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

/** A filesystem failure carrying `description`, as the real service raises. */
function fsFailure(
  method: 'readFileString' | 'writeFileString',
  description: string,
): PlatformError.PlatformError {
  return PlatformError.badArgument({
    module: 'FileSystem',
    method,
    description,
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

  const failureCases = [
    {
      name: 'read failure',
      read: () => Effect.fail(fsFailure('readFileString', 'read failed')),
      write: () => Effect.void,
      log: 'Error processing input commands in /run/chapter_r1.tex: FileSystem.readFileString: read failed',
      writeNotCalled: true,
    },
    {
      name: 'write failure',
      read: () => Effect.succeed(String.raw`\input{chapter}`),
      write: () => Effect.fail(fsFailure('writeFileString', 'write failed')),
      log: 'Error processing input commands in /run/chapter_r1.tex: FileSystem.writeFileString: write failed',
      writeNotCalled: false,
    },
  ];

  for (const { name, read, write, log, writeNotCalled } of failureCases) {
    it.effect(`logs a ${name} without failing the replacement pass`, () =>
      Effect.gen(function* () {
        const base = externalLocation('/workspace/chapter.tex');
        const output = externalLocation('/run/chapter_r1.tex');
        const writeSpy = vi.fn(write);
        const warn = vi.fn<AgentTrace['warn']>();
        const logger = spiedTrace({ warn });

        // A per-file failure must not fail the pass: assert through the exit
        // so a sync throw inside the program reads as the defect it is.
        const exit = yield* Effect.exit(
          withFsOverrides(
            { readFileString: read, writeFileString: writeSpy },
            replaceInputCommands([base], [output], logger),
          ),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        if (writeNotCalled) {
          expect(writeSpy).not.toHaveBeenCalled();
        }
        expect(warn).toHaveBeenCalledWith(log);
      }).pipe(Effect.provide(nodePlatformLayer)),
    );
  }
});
