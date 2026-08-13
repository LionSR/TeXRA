import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStderrAndWait,
  writeTextStdout,
  writeTextStdoutAndWait,
} from '@cli/runtime/logSinks';
import { pageStdout } from '@cli/runtime/pager';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';

/**
 * Sink for human-facing progress during a long command: stdout in text mode,
 * stderr otherwise, so `--output-format json|ndjson` keeps stdout parseable.
 */
export function cliProgressWriter(
  context: Pick<CliContext, 'outputFormat'>,
): (text: string) => void {
  return context.outputFormat === 'text' ? writeTextStdout : writeTextStderr;
}

/** Awaitable counterpart for signal shutdown, where process.exit follows the
 * lifecycle drain and accepted text must reach its destination first. */
export function writeCliProgressAndWait(
  context: Pick<CliContext, 'outputFormat'>,
  text: string,
): Promise<void> {
  return context.outputFormat === 'text'
    ? writeTextStdoutAndWait(text)
    : writeTextStderrAndWait(text);
}

/**
 * Single home for the `json` / `ndjson` / `text` switch every headless command
 * repeats. Pass the already-formatted value for each format; the active
 * `outputFormat` selects one. NDJSON accepts a single record or a list, and a
 * `ts` timestamp is stamped on any record that doesn't already carry one (so
 * pre-built record helpers keep their own).
 *
 * Values are eager: a one-shot command renders a single result, so formatting
 * the unused branches is negligible and keeps call sites flat.
 *
 * `paged: true` routes the **text** branch (only) through `$PAGER` when stdout
 * is an interactive TTY and the context is not headless — for list commands
 * that can exceed a screen. It is a strict no-op on non-TTY or headless
 * contexts (`--print`, `--no-input`, piped / `--output-format json|ndjson`), so
 * scriptable byte output is unchanged. JSON/NDJSON are never paged.
 */
export function emitCliResult(
  context: Pick<CliContext, 'outputFormat'> &
    Partial<Pick<CliContext, 'stdoutIsTty' | 'mode'>>,
  result: {
    readonly json: unknown;
    readonly ndjson: CliNdjsonRecord | readonly CliNdjsonRecord[];
    readonly text: string;
  },
  options: { readonly paged?: boolean } = {},
): void {
  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(result.json, null, 2));
    return;
  }
  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    const records = Array.isArray(result.ndjson)
      ? result.ndjson
      : [result.ndjson];
    for (const record of records) {
      // Append `ts` rather than prepending so call sites that put `kind`
      // first keep it as the first JSON key — line-oriented consumers
      // (`grep`, `awk`) often anchor on `{"kind":` at the start of each line.
      writeNdjsonStdout('ts' in record ? record : { ...record, ts });
    }
    return;
  }
  // Skip the write for empty text so list commands print nothing (not a bare
  // newline) when there are no rows — matching the pre-helper per-row loops.
  if (!result.text) return;
  if (options.paged === true) {
    pageStdout(result.text, {
      stdoutIsTty: context.stdoutIsTty,
      headless: context.mode === 'headless',
    });
    return;
  }
  writeTextStdout(result.text);
}
