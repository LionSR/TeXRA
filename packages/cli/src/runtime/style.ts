import pico from 'picocolors';

/**
 * Semantic style vocabulary for the CLI's plain-text (non-Ink) output. Built
 * on picocolors so every styled surface shares one color path and one gate.
 *
 * The gate is a per-stream color boolean from `CliContext`:
 * `stdoutColorEnabled` for stdout-bound output (e.g. `doctor`'s success
 * report), `stderrColorEnabled` for stderr-bound output
 * (progress, update checker). Both are computed in `readCliAmbientState`
 * honoring TTY, `NO_COLOR`,
 * `FORCE_COLOR`, `TERM=dumb`, and `--no-color`. When the gate is false,
 * picocolors' `createColors(false)` hands back identity functions, so call
 * sites never branch on color themselves — they always go through the same
 * helper and stay consistent with each other and with the Ink TUI / markdown
 * renderer.
 */
export interface CliStyle {
  /** Whether styling actually emits color (false ⇒ every method is identity). */
  readonly enabled: boolean;
  /** Passing/healthy state — green. */
  success(text: string): string;
  /** Cautionary state — yellow. */
  warn(text: string): string;
  /** Failing/error state — red. */
  error(text: string): string;
  /** Draw the eye to a value — bold. */
  emphasis(text: string): string;
  /** De-emphasize secondary detail (hints, separators) — dim. */
  muted(text: string): string;
  /** A shell command the user can copy/run — cyan. */
  command(text: string): string;
}

export function createCliStyle(colorEnabled: boolean): CliStyle {
  const c = pico.createColors(colorEnabled);
  return {
    enabled: colorEnabled,
    success: (text) => c.green(text),
    warn: (text) => c.yellow(text),
    error: (text) => c.red(text),
    emphasis: (text) => c.bold(text),
    muted: (text) => c.dim(text),
    command: (text) => c.cyan(text),
  };
}
