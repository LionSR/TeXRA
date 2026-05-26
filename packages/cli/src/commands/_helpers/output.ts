import { writeNdjsonStdout, writeTextStdout } from '@cli/runtime/logSinks';
import type { CliContext } from '@cli/runtime/cliContext';

export type CliNdjsonRecord = object;

/**
 * Single home for the `json` / `ndjson` / `text` switch every headless command
 * repeats. Pass the already-formatted value for each format; the active
 * `outputFormat` selects one. NDJSON accepts a single record or a list, and a
 * `ts` timestamp is stamped on any record that doesn't already carry one (so
 * pre-built record helpers keep their own).
 *
 * Values are eager: a one-shot command renders a single result, so formatting
 * the unused branches is negligible and keeps call sites flat.
 */
export function emitCliResult(
  context: Pick<CliContext, 'outputFormat'>,
  result: {
    readonly json: unknown;
    readonly ndjson: CliNdjsonRecord | readonly CliNdjsonRecord[];
    readonly text: string;
  },
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
      writeNdjsonStdout('ts' in record ? record : { ts, ...record });
    }
    return;
  }
  writeTextStdout(result.text);
}
