import { spawnSync } from 'node:child_process';

import { readCliEnv } from './cliContext';
import { writeTextStdout } from './logSinks';

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
  env: Record<string, string | undefined> = readCliEnv(),
): string | undefined {
  const pager = env.PAGER;
  if (pager === undefined) return DEFAULT_PAGER;
  const trimmed = pager.trim();
  // `PAGER=` (empty) or `PAGER=cat` are the conventional "no pager" signals.
  if (trimmed === '' || trimmed === 'cat') return undefined;
  return trimmed;
}

/**
 * Write `text` to stdout, paging through `$PAGER` (default `less -FIRX`) **only**
 * when stdout is an interactive TTY. When stdout is not a TTY (piped, redirected,
 * `--print`, `--no-input`, `--output-format json|ndjson`) this is a strict
 * no-op wrapper around `writeTextStdout` — byte-identical to writing directly,
 * so headless parity is preserved.
 *
 * If spawning the pager fails for any reason (missing binary, spawn error), we
 * fall back to writing the text directly rather than swallowing the output.
 */
export function pageStdout(
  text: string,
  options: {
    readonly stdoutIsTty?: boolean;
    readonly headless?: boolean;
    readonly env?: Record<string, string | undefined>;
  } = {},
): void {
  // Empty output never pages — mirrors `emitCliResult`'s skip-empty behavior.
  if (text === '') return;

  if (options.headless === true || options.stdoutIsTty !== true) {
    writeTextStdout(text);
    return;
  }

  const env = options.env ? { ...readCliEnv(), ...options.env } : readCliEnv();
  const command = resolvePagerCommand(env);
  if (!command) {
    writeTextStdout(text);
    return;
  }

  // Run through the default shell so `$PAGER` strings with flags ("less -FIRX")
  // and user customizations work without us re-implementing shell word-splitting.
  // Uses raw spawnSync (not executeCommand) because the pager needs true
  // stdio:['pipe','inherit','inherit'] — full-duplex TTY control for
  // interactive paging that executeCommand's buffered/streamed output can't
  // provide.
  const result = spawnSync(command, {
    input: `${text}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: true,
    env: options.env ? env : undefined,
  });

  if (result.error || result.status === 126 || result.status === 127) {
    // The pager could not be launched (e.g. `less` not installed). Don't lose
    // the content: write it straight to stdout instead.
    writeTextStdout(text);
  }
}
