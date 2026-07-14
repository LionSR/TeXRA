// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { noopTrace, type AgentTrace } from '@agent/trace';
import {
  createFileMapping,
  replaceInputCommands,
} from '@agent/output/fileMapping';

// Local imports - shared
import type { FileLocation } from '@shared/schemas';

// Local imports - utilities
import { FlexibleFS } from '@utils/files/flexibleFS';

function externalLocation(absolutePath: string): FileLocation {
  return { kind: 'external', absolutePath };
}

function createLogger(): {
  logger: AgentTrace;
  warn: ReturnType<typeof vi.fn<AgentTrace['warn']>>;
} {
  const warn = vi.fn<AgentTrace['warn']>();
  return {
    logger: { ...noopTrace, debug: vi.fn(), warn },
    warn,
  };
}

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
      .spyOn(FlexibleFS, 'read')
      .mockImplementation((location) =>
        Promise.resolve(
          location === outputMain
            ? String.raw`\input{sections/method}`
            : 'Section content',
        ),
      );
    const write = vi.spyOn(FlexibleFS, 'write').mockResolvedValue();

    await replaceInputCommands(
      [baseMain, baseSection],
      [outputMain, outputSection],
    );

    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      outputMain,
      String.raw`\input{sections/method_r1}`,
    );
  });

  it('logs a read failure and leaves the output unchanged', async () => {
    const base = externalLocation('/workspace/chapter.tex');
    const output = externalLocation('/run/chapter_r1.tex');
    vi.spyOn(FlexibleFS, 'read').mockRejectedValue(new Error('read failed'));
    const write = vi.spyOn(FlexibleFS, 'write').mockResolvedValue();
    const { logger, warn } = createLogger();

    await expect(
      replaceInputCommands([base], [output], logger),
    ).resolves.toBeUndefined();

    expect(write).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Error processing input commands in /run/chapter_r1.tex: read failed',
    );
  });

  it('logs a write failure without rejecting the replacement pass', async () => {
    const base = externalLocation('/workspace/chapter.tex');
    const output = externalLocation('/run/chapter_r1.tex');
    vi.spyOn(FlexibleFS, 'read').mockResolvedValue(String.raw`\input{chapter}`);
    vi.spyOn(FlexibleFS, 'write').mockRejectedValue(new Error('write failed'));
    const { logger, warn } = createLogger();

    await expect(
      replaceInputCommands([base], [output], logger),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Error processing input commands in /run/chapter_r1.tex: write failed',
    );
  });
});
