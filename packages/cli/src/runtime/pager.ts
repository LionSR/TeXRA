import { Effect, type Result } from 'effect';

import { cliEnvValue } from './cliContext';
import { runForegroundCommand } from './foregroundCommand';
import { writeTextStdout } from './logSinks';
import type { PlatformError } from 'effect/PlatformError';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * Default pager command (clig.dev's suggestion). `less` flags:
 *   -F  quit immediately if the content fits on one screen (no-op for short
 *       output, so the user never has to press `q` for a 3-line list).
 *   -I  case-insensitive search.
 *   -R  pass through ANSI color so styled output survives the pager.
 *   -X  don't clear the screen on exit, leaving the output in scrollback.
 */
const DEFAULT_PAGER = 'less -FIRX';

/**
 * Resolve the pager command from `$PAGER` (then `$TEXRA_PAGER` is *not* a thing
 * — we deliberately reuse the conventional env var). An explicitly empty
 * `PAGER=` disables paging, matching how `git`/`man` treat it.
 */
export function resolvePagerCommand(
  pagerEnv: string | undefined,
): string | undefined {
  const pager = pagerEnv?.trim() ?? DEFAULT_PAGER;
  // `PAGER=` (empty) or `PAGER=cat` are the conventional "no pager" signals.
  if (pager === '' || pager === 'cat') return undefined;
  return pager;
}

/**
 * Write `text` to stdout, paging through `$PAGER` (default `less -FIRX`) **only**
 * when stdout is an interactive TTY. When stdout is not a TTY (piped, redirected,
 * `--print`, `--no-input`, `--output-format json|ndjson`) this is a strict
 * no-op wrapper around `writeTextStdout` — byte-identical to writing directly,
 * so headless parity is preserved.
 *
 * If the pager cannot start (missing binary, spawn error), the text is written
 * directly, with the cause logged, rather than lost.
 */
export const pageStdout = Effect.fn('pageStdout')(function* (
  text: string,
  options: {
    readonly stdoutIsTty?: boolean;
    readonly headless?: boolean;
    /** `$PAGER` in place of the live one; `''` disables paging. */
    readonly pager?: string;
  } = {},
): Effect.fn.Return<void, never, ChildProcessSpawner> {
  // Empty output never pages — mirrors `emitCliResult`'s skip-empty behavior.
  if (text === '') return;

  if (options.headless === true || options.stdoutIsTty !== true) {
    writeTextStdout(text);
    return;
  }

  const command = resolvePagerCommand(options.pager ?? cliEnvValue('PAGER'));
  if (!command) {
    writeTextStdout(text);
    return;
  }

  // Through the shell so `$PAGER` strings with flags ("less -FIRX") and user
  // customizations work without re-implementing shell word-splitting. The
  // pager owns the terminal: stdout and stderr are inherited and the text
  // arrives on its stdin.
  const launched = yield* Effect.result(
    runForegroundCommand(command, { input: `${text}\n` }),
  );
  const failure = pagerLaunchFailure(launched);
  if (failure !== undefined) {
    // The pager could not be launched (e.g. `less` not installed). Don't lose
    // the content: write it straight to stdout instead.
    yield* Effect.logWarning(
      `The pager could not run (${failure}); writing the output directly.`,
    );
    writeTextStdout(text);
  }
});

/**
 * Why the pager never showed the text, or undefined when it ran. A pager that
 * ended by a signal did run; only a launch failure (a missing shell, or the
 * shell's 126/127 for a missing pager) loses the output.
 */
function pagerLaunchFailure(
  launched: Result.Result<number, PlatformError>,
): string | undefined {
  if (launched._tag === 'Failure') {
    const { reason } = launched.failure;
    return reason.method === 'exitCode' ? undefined : reason._tag;
  }
  return launched.success === 126 || launched.success === 127
    ? `exit ${launched.success}`
    : undefined;
}
