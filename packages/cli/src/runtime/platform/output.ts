import { Effect } from 'effect';

import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '@cli/runtime/platform/logSinks';
import { pageStdout } from '@cli/runtime/terminal/pager';
import { CliInvocation } from '@cli/runtime/platform/cliContext';
import type { CliOutputFormat } from '@texra/shared/cliOutputFormat';
import {
  CLI_RESULT_FIELD,
  type CliNdjsonRecord,
  type CliResultKind,
} from '@cli/schemas/cliOutput';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * Sink for human-facing progress during a long command: stdout in text mode,
 * stderr otherwise, so `--output-format json|ndjson` keeps stdout parseable.
 */
export const cliProgressWriter = CliInvocation.useSync(
  ({ context }): ((text: string) => void) =>
    context.outputFormat === 'text' ? writeTextStdout : writeTextStderr,
);

interface CliResult {
  readonly json: unknown;
  readonly ndjson: CliNdjsonRecord | readonly CliNdjsonRecord[];
  readonly text: string;
}

/** A result of a one-field kind: `value` in JSON; in NDJSON, `value` (each
 *  element of a list, one line each) under the field its kind fixes. */
export function cliResult(
  kind: CliResultKind,
  value: unknown,
  text: string,
): CliResult {
  const field = CLI_RESULT_FIELD[kind];
  // cast: the field is the one `CLI_RESULT_FIELD` names for `kind`.
  const line = (payload: unknown) =>
    ({ kind, [field]: payload }) as CliNdjsonRecord;
  return {
    json: value,
    ndjson: Array.isArray(value) ? value.map(line) : line(value),
    text,
  };
}

/** A command's own result record: itself in JSON, a `result` record naming
 *  the command in NDJSON. */
export const commandResult = (
  command: string,
  result: Readonly<Record<string, unknown>>,
  text: string,
): CliResult => ({
  json: result,
  ndjson: { kind: 'result', result: { command, ...result } },
  text,
});

/**
 * Single home for the `json` / `ndjson` / `text` switch every headless command
 * repeats. Pass the already-formatted value for each format; the active
 * `outputFormat` selects one. NDJSON accepts a single record or a list.
 *
 * Values are eager: a one-shot command renders a single result, so formatting
 * the unused branches is negligible and keeps call sites flat.
 */
export const emitCliResult = (result: CliResult) =>
  CliInvocation.useSync(({ context }) =>
    writeCliResult(context.outputFormat, result),
  );

/** {@link emitCliResult} for a caller that holds the context's format and
 *  runs outside the invocation's program (the clone workflow's ports). */
export function writeCliResult(
  outputFormat: CliOutputFormat,
  result: CliResult,
): void {
  if (outputFormat === 'json') {
    writeTextStdout(JSON.stringify(result.json, null, 2));
    return;
  }
  if (outputFormat === 'ndjson') {
    const records = Array.isArray(result.ndjson)
      ? result.ndjson
      : [result.ndjson];
    for (const record of records) writeNdjsonStdout(record);
    return;
  }
  // Skip the write for empty text so list commands print nothing (not a bare
  // newline) when there are no rows — matching the pre-helper per-row loops.
  if (!result.text) return;
  writeTextStdout(result.text);
}

/**
 * {@link emitCliResult}, with the **text** branch (only) routed through
 * `$PAGER` when stdout is an interactive TTY and the context is not headless —
 * for list commands that can exceed a screen. It is a strict no-op on non-TTY
 * or headless contexts (`--print`, `--no-input`, piped / `--output-format
 * json|ndjson`), so scriptable byte output is unchanged. JSON/NDJSON are never
 * paged.
 */
export const emitPagedCliResult = (
  result: CliResult,
): Effect.Effect<void, never, ChildProcessSpawner | CliInvocation> =>
  CliInvocation.use(({ context }) =>
    context.outputFormat !== 'text' || !result.text
      ? Effect.sync(() => writeCliResult(context.outputFormat, result))
      : pageStdout(result.text, {
          stdoutIsTty: context.stdoutIsTty,
          headless: context.mode === 'headless',
        }),
  );
