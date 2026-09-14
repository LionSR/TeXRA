// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import {
  createFileMapping,
  replaceInputCommands,
} from '@agent/implementations/flows/reflection/output/fileMapping';
import { spiedTrace } from '@test/support/spiedTrace';
import { createExternalLocation as externalLocation } from '@utils/files/fileLocation';
import { AbsoluteFS } from '@utils/files/absoluteFS';

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
      const read = vi
        .spyOn(AbsoluteFS, 'read')
        .mockImplementation((target) =>
          Promise.resolve(
            target === outputMain.absolutePath
              ? String.raw`\input{sections/method}`
              : 'Section content',
          ),
        );
      const write = vi.spyOn(AbsoluteFS, 'write').mockResolvedValue();

      yield* replaceInputCommands(
        [baseMain, baseSection],
        [outputMain, outputSection],
      );

      expect(read).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith(
        outputMain.absolutePath,
        String.raw`\input{sections/method_r1}`,
      );
    }),
  );

  const failureCases = [
    {
      name: 'read failure',
      read: async () => {
        throw new Error('read failed');
      },
      write: async () => {},
      log: 'Error processing input commands in /run/chapter_r1.tex: read failed',
      writeNotCalled: true,
    },
    {
      name: 'write failure',
      read: async () => String.raw`\input{chapter}`,
      write: async () => {
        throw new Error('write failed');
      },
      log: 'Error processing input commands in /run/chapter_r1.tex: write failed',
      writeNotCalled: false,
    },
  ];

  for (const { name, read, write, log, writeNotCalled } of failureCases) {
    it.effect(`logs a ${name} without failing the replacement pass`, () =>
      Effect.gen(function* () {
        const base = externalLocation('/workspace/chapter.tex');
        const output = externalLocation('/run/chapter_r1.tex');
        vi.spyOn(AbsoluteFS, 'read').mockImplementation(read);
        const writeSpy = vi
          .spyOn(AbsoluteFS, 'write')
          .mockImplementation(write);
        const warn = vi.fn<AgentTrace['warn']>();
        const logger = spiedTrace({ warn });

        // A per-file failure must not fail the pass: assert through the exit
        // so a sync throw inside the program reads as the defect it is.
        const exit = yield* Effect.exit(
          replaceInputCommands([base], [output], logger),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        if (writeNotCalled) {
          expect(writeSpy).not.toHaveBeenCalled();
        }
        expect(warn).toHaveBeenCalledWith(log);
      }),
    );
  }
});
