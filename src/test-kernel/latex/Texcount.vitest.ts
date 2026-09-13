import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LATEX_COMMANDS_CHANNEL } from '@latex/latexLogging';
import { getTeXCount } from '@latex/texcount';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { platform } from '@platform/platform';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, runToolWithCheck: mocks.runToolWithCheck };
});

/**
 * The fake platform, with debug mode on: the Effect logger drops `Debug`
 * entries otherwise, and these assertions are about which channel an entry
 * lands on, not about that gate.
 */
const withPlatform = (
  files: Record<string, string> = {},
): Effect.Effect<void> =>
  Effect.promise(() =>
    installPlatform({
      workspacePath: '/workspace',
      config: { 'texra.logger.debugMode': true },
      files,
    }),
  ).pipe(Effect.asVoid);

/** The logger production installs, so entries reach the captured sink. */
const withDiagnostics = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.provide(self, effectDiagnosticsLayer);

// #10635: getTeXCount names its channel once for the whole count, so every
// entry a helper writes carries the caller's channel rather than the module
// default it was declared with.
describe('texcount diagnostics', () => {
  beforeEach(() => {
    mocks.runToolWithCheck.mockReset();
  });

  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  it.effect('warns on the resolved channel when no files are provided', () =>
    Effect.gen(function* () {
      yield* withPlatform();
      const logs = captureLogEntries();

      const pinned = yield* getTeXCount('   ', { channel: 'pinnedTexcount' });
      const defaulted = yield* getTeXCount('');

      expect(pinned).toEqual({
        output: null,
        errors: ['No LaTeX files provided for texcount.'],
      });
      expect(defaulted).toEqual(pinned);
      expect(
        logs.has(
          'WARN',
          'pinnedTexcount',
          'No LaTeX files provided for texcount.',
        ),
      ).toBe(true);
      expect(
        logs.has(
          'WARN',
          LATEX_COMMANDS_CHANNEL,
          'No LaTeX files provided for texcount.',
        ),
      ).toBe(true);
    }).pipe(withDiagnostics),
  );

  it.effect('warns on the resolved channel when a file does not exist', () =>
    Effect.gen(function* () {
      yield* withPlatform();
      const logs = captureLogEntries();

      const result = yield* getTeXCount('missing.tex', {
        channel: 'pinnedTexcount',
      });

      expect(result.output).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(logs.has('WARN', 'pinnedTexcount', 'does not exist')).toBe(true);
    }).pipe(withDiagnostics),
  );

  // The Chinese-package probe is best-effort, and its failure is reported on
  // the count's own channel rather than on a channel the helper picked.
  it.effect(
    'reports a failed Chinese-package check on the resolved channel',
    () =>
      Effect.gen(function* () {
        yield* withPlatform({
          '/workspace/main.tex': '\\documentclass{article}\n',
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
        const logs = captureLogEntries();

        const result = yield* getTeXCount('main.tex', {
          channel: 'pinnedTexcount',
        });

        // The failed probe is best-effort: the count still runs.
        expect(result.output).toContain('Words in text: 5');
        expect(
          logs.has(
            'ERROR',
            'pinnedTexcount',
            'Error checking Chinese packages: disk flutter',
          ),
        ).toBe(true);
      }).pipe(withDiagnostics),
  );

  it.effect(
    'logs a failing texcount invocation at error level on the resolved channel',
    () =>
      Effect.gen(function* () {
        yield* withPlatform({
          '/workspace/main.tex': '\\documentclass{article}\n',
        });
        mocks.runToolWithCheck.mockResolvedValue({
          success: false,
          stdout: 'partial output',
          stderr: 'texcount exploded',
          exitCode: 1,
        });
        const logs = captureLogEntries();

        const result = yield* getTeXCount('main.tex', {
          channel: 'pinnedTexcount',
        });

        expect(result.output).toBeNull();
        expect(result.errors.join('\n')).toContain('texcount exploded');
        expect(
          logs.has('ERROR', 'pinnedTexcount', 'Error getting tex count for'),
        ).toBe(true);
        expect(
          logs.has('ERROR', 'pinnedTexcount', 'Stderr: texcount exploded'),
        ).toBe(true);
      }).pipe(withDiagnostics),
  );

  // #10649: pins the sum-mode path's own emission — getSummedCount's
  // Chinese-package line reaches the caller's channel and the default one.
});
