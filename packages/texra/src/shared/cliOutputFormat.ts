import { Effect, Schema } from 'effect';

/**
 * Output formats every `texra` command can emit: human text, one JSON result,
 * or a stream of NDJSON records. The `texra.outputFormat` catalog row, the `--output-format`
 * flag, and the `TEXRA_OUTPUT_FORMAT` environment read all parse the same list.
 */
export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;

/** Canonical config key for the CLI's output format. */
export const CLI_OUTPUT_FORMAT_CONFIG_KEY = 'texra.outputFormat';

export const CliOutputFormatSchema = Schema.Literals(CLI_OUTPUT_FORMATS).pipe(
  Schema.withDecodingDefault(Effect.succeed('text')),
);

export type CliOutputFormat = typeof CliOutputFormatSchema.Type;
