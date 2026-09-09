import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LATEX_COMMANDS_CHANNEL } from '@latex/latexLogging';
import { getTeXCount } from '@latex/texcount';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { installPlatform } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, runToolWithCheck: mocks.runToolWithCheck };
});

/** The memfs platform install, as a step inside an `it.effect` program. */
const withPlatform = (
  options: Parameters<typeof installPlatform>[0],
): Effect.Effect<void> =>
  Effect.promise(() => installPlatform(options)).pipe(Effect.asVoid);

// #10635: texcount's helpers resolve their logger per function from the
// threaded channel — a logger-namespace spy must observe the resolved channel.
describe('texcount logger seam', () => {
  beforeEach(() => {
    mocks.runToolWithCheck.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('warns on the resolved channel when no files are provided', () =>
    Effect.gen(function* () {
      yield* withPlatform({ workspacePath: '/workspace' });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const pinned = yield* getTeXCount('   ', { channel: 'pinnedTexcount' });
      const defaulted = yield* getTeXCount('');

      expect(pinned).toEqual({
        output: null,
        errors: ['No LaTeX files provided for texcount.'],
      });
      expect(defaulted).toEqual(pinned);
      expect(warn).toHaveBeenCalledWith(
        'pinnedTexcount',
        'No LaTeX files provided for texcount.',
      );
      expect(warn).toHaveBeenCalledWith(
        LATEX_COMMANDS_CHANNEL,
        'No LaTeX files provided for texcount.',
      );
    }),
  );

  it.effect('warns on the resolved channel when a file does not exist', () =>
    Effect.gen(function* () {
      yield* withPlatform({ workspacePath: '/workspace' });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = yield* getTeXCount('missing.tex', {
        channel: 'pinnedTexcount',
      });

      expect(result.output).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        'pinnedTexcount',
        expect.stringContaining('does not exist'),
      );
    }),
  );

  // The module-level `const log = createLog(CHANNEL)` in texcount.ts is bound
  // at import time, before this suite's spy exists — exactly the case
  // createLog's per-call loggerSelf lookup exists for. A read failure inside
  // hasChinesePackages must still reach the spied namespace.
  it.effect(
    'emits through the import-time module binding when the Chinese-package check fails',
    () =>
      Effect.gen(function* () {
        yield* withPlatform({
          workspacePath: '/workspace',
          files: { '/workspace/main.tex': '\\documentclass{article}\n' },
        });
        // The first (and only) AbsoluteFS.read here is hasChinesePackages'.
        vi.spyOn(platform().fs, 'readFile').mockRejectedValueOnce(
          new Error('disk flutter'),
        );
        mocks.runToolWithCheck.mockResolvedValue({
          success: true,
          stdout: 'Words in text: 5',
          stderr: '',
          exitCode: 0,
        });
        const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

        const result = yield* getTeXCount('main.tex');

        // The failed Chinese-package probe is best-effort: the count runs.
        expect(result.output).toContain('Words in text: 5');
        expect(error).toHaveBeenCalledWith(
          LATEX_COMMANDS_CHANNEL,
          expect.stringContaining(
            'Error checking Chinese packages: disk flutter',
          ),
        );
      }),
  );

  it.effect(
    'logs a failing texcount invocation at error level on the resolved channel',
    () =>
      Effect.gen(function* () {
        yield* withPlatform({
          workspacePath: '/workspace',
          files: { '/workspace/main.tex': '\\documentclass{article}\n' },
        });
        mocks.runToolWithCheck.mockResolvedValue({
          success: false,
          stdout: 'partial output',
          stderr: 'texcount exploded',
          exitCode: 1,
        });
        const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

        const result = yield* getTeXCount('main.tex', {
          channel: 'pinnedTexcount',
        });

        expect(result.output).toBeNull();
        expect(result.errors.join('\n')).toContain('texcount exploded');
        expect(error).toHaveBeenCalledWith(
          'pinnedTexcount',
          expect.stringContaining('Error getting tex count for'),
        );
        expect(error).toHaveBeenCalledWith(
          'pinnedTexcount',
          expect.stringContaining('Stderr: texcount exploded'),
        );
      }),
  );

  // #10649: pins the sum-mode path's own log emission: getSummedCount's
  // Chinese-package debug line reaches the spied namespace at debug level
  // with its exact message, on both the threaded channel and the default
  // LATEX_COMMANDS_CHANNEL. The spy is installed before the per-call
  // createLog runs, so this test does not prove call-time loggerSelf
  // delegation; that bind-time-vs-call-time seam is guarded by the
  // import-time hasChinesePackages test above.
  it.effect(
    'emits the sum-mode Chinese-package debug line on the resolved channel',
    () =>
      Effect.gen(function* () {
        yield* withPlatform({
          workspacePath: '/workspace',
          files: { '/workspace/main.tex': '\\documentclass{ctexart}\n' },
        });
        mocks.runToolWithCheck.mockResolvedValue({
          success: true,
          stdout: 'Words in text: 5',
          stderr: '',
          exitCode: 0,
        });
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

        const pinned = yield* getTeXCount('main.tex', {
          mode: 'sum',
          channel: 'pinnedTexcount',
        });
        const defaulted = yield* getTeXCount('main.tex', { mode: 'sum' });

        // The (sum) prefix proves the summed path, not the per-file path, ran.
        expect(pinned.output).toContain('Combined TeX Count Results (sum):');
        expect(defaulted).toEqual(pinned);
        expect(debug).toHaveBeenCalledWith(
          'pinnedTexcount',
          'Chinese packages detected in main.tex, enabling Chinese character counting',
        );
        expect(debug).toHaveBeenCalledWith(
          LATEX_COMMANDS_CHANNEL,
          'Chinese packages detected in main.tex, enabling Chinese character counting',
        );
      }),
  );
});
