import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer, PlatformError } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LATEX_COMMANDS_CHANNEL } from '@latex/latexLogging';
import { getTeXCount } from '@latex/texcount';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

const mocks = vi.hoisted(() => ({
  runToolWithCheck: vi.fn(),
}));

/** The counted workspace's setting slots, carried by the caller as data. */
const settings = makeFakeSettingsStores().stores;

vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, runToolWithCheck: mocks.runToolWithCheck };
});

/**
 * The fake platform, with debug mode on: the Effect logger drops `Debug`
 * entries, and these assertions verify which channel receives them.
 */
const withPlatform = (
  files: Record<string, string> = {},
): Effect.Effect<void> =>
  Effect.promise(() =>
    installPlatform({ workspacePath: fakePath('workspace'), files }),
  ).pipe(Effect.asVoid);

/** The logger production installs, so entries reach the captured sink. */
const withDiagnostics = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.provide(self, effectDiagnosticsLayer('Trace'));

/**
 * A `FileSystem` that reports every path as present and fails every read with
 * `message`: the injected read failure the Chinese-package probe must treat as
 * best-effort. The probe reads through the context `FileSystem`, so the
 * failure is injected as a layer.
 */
function failingReadLayer(message: string): Layer.Layer<FileSystem.FileSystem> {
  return FileSystem.layerNoop({
    exists: () => Effect.succeed(true),
    readFile: (path) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: 'BadResource',
          module: 'FileSystem',
          method: 'readFile',
          pathOrDescriptor: path,
          description: message,
        }),
      ),
  });
}

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

      const pinned = yield* getTeXCount(fakePath('workspace'), '   ', {
        channel: 'pinnedTexcount',
        settings,
      });
      const defaulted = yield* getTeXCount(fakePath('workspace'), '', {
        settings,
      });

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
    }).pipe(withDiagnostics, Effect.provide(nodePlatformLayer)),
  );

  it.effect('warns on the resolved channel when a file does not exist', () =>
    Effect.gen(function* () {
      yield* withPlatform();
      const logs = captureLogEntries();

      const result = yield* getTeXCount(fakePath('workspace'), 'missing.tex', {
        channel: 'pinnedTexcount',
        settings,
      });

      expect(result.output).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(logs.has('WARN', 'pinnedTexcount', 'does not exist')).toBe(true);
    }).pipe(withDiagnostics, Effect.provide(nodePlatformLayer)),
  );

  // The Chinese-package probe is best-effort, and its failure is reported on
  // the count's own channel rather than on a channel the helper picked.
  it.effect(
    'reports a failed Chinese-package check on the resolved channel',
    () =>
      Effect.gen(function* () {
        yield* withPlatform();
        mocks.runToolWithCheck.mockReturnValue(
          Effect.succeed({
            success: true,
            stdout: 'Words in text: 5',
            stderr: '',
            exitCode: 0,
          }),
        );
        const logs = captureLogEntries();

        const result = yield* getTeXCount(fakePath('workspace'), 'main.tex', {
          channel: 'pinnedTexcount',
          settings,
        });

        // The failed probe is best-effort: the count still runs.
        expect(result.output).toContain('Words in text: 5');
        // The failure is logged with its prefix and its cause on the count's
        // own channel.
        expect(
          logs.has(
            'ERROR',
            'pinnedTexcount',
            'Error checking Chinese packages',
          ),
        ).toBe(true);
        expect(logs.has('ERROR', 'pinnedTexcount', 'disk flutter')).toBe(true);
      }).pipe(
        withDiagnostics,
        Effect.provide(failingReadLayer('disk flutter')),
      ),
  );

  it.effect(
    'logs a failing texcount invocation at error level on the resolved channel',
    () =>
      Effect.gen(function* () {
        yield* withPlatform({
          '/workspace/main.tex': '\\documentclass{article}\n',
        });
        mocks.runToolWithCheck.mockReturnValue(
          Effect.succeed({
            success: false,
            stdout: 'partial output',
            stderr: 'texcount exploded',
            exitCode: 1,
          }),
        );
        const logs = captureLogEntries();

        const result = yield* getTeXCount(fakePath('workspace'), 'main.tex', {
          channel: 'pinnedTexcount',
          settings,
        });

        expect(result.output).toBeNull();
        expect(result.errors.join('\n')).toContain('texcount exploded');
        expect(
          logs.has('ERROR', 'pinnedTexcount', 'Error getting tex count for'),
        ).toBe(true);
        expect(
          logs.has('ERROR', 'pinnedTexcount', 'Stderr: texcount exploded'),
        ).toBe(true);
      }).pipe(withDiagnostics, Effect.provide(nodePlatformLayer)),
  );

  // #10649: pins the sum-mode path's own emission — getSummedCount's
  // Chinese-package line reaches the caller's channel and the default one.
});
