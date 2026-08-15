// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const target = externalLocation('/run/results_r2.tex');

    const mapping = createFileMapping(
      [firstSource, secondSource],
      [target],
      'basename',
      true,
    );

    expect([...mapping.entries()]).toEqual([
      [firstSource.absolutePath, target],
    ]);
  });

  it('matches generated files across round suffixes only when round-aware', () => {
    const previousRound = externalLocation('/run/results_r1.tex');
    const currentRound = externalLocation('/run/results_r2.tex');

    expect(
      createFileMapping([previousRound], [currentRound], 'basename'),
    ).toEqual(new Map());
    expect(
      createFileMapping([previousRound], [currentRound], 'basename', true),
    ).toEqual(new Map([[previousRound.absolutePath, currentRound]]));
  });
});

describe('replaceInputCommands', () => {
  it('rewrites an extensionless LaTeX input to the generated file', async () => {
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

    await replaceInputCommands(
      [baseMain, baseSection],
      [outputMain, outputSection],
    );

    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      outputMain.absolutePath,
      String.raw`\input{sections/method_r1}`,
    );
  });

  it.each([
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
  ])(
    'logs a $name without rejecting the replacement pass',
    async ({ read, write, log, writeNotCalled }) => {
      const base = externalLocation('/workspace/chapter.tex');
      const output = externalLocation('/run/chapter_r1.tex');
      vi.spyOn(AbsoluteFS, 'read').mockImplementation(read);
      const writeSpy = vi.spyOn(AbsoluteFS, 'write').mockImplementation(write);
      const warn = vi.fn<AgentTrace['warn']>();
      const logger = spiedTrace({ warn });

      await expect(
        replaceInputCommands([base], [output], logger),
      ).resolves.toBeUndefined();

      if (writeNotCalled) {
        expect(writeSpy).not.toHaveBeenCalled();
      }
      expect(warn).toHaveBeenCalledWith(log);
    },
  );
});
