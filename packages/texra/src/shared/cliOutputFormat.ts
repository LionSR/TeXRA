import { Schema } from 'effect';
import { decodingDefault } from '@texra-ai/harness/schemas';

/**
 * Output formats every `texra` command can emit: human text, one JSON result,
 * or a stream of NDJSON records. The `outputFormat` catalog row, the
 * `--output-format` flag, and the `TEXRA_OUTPUT_FORMAT` environment read all
 * parse the same list.
 */
export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;

export const CliOutputFormatSchema = decodingDefault(
  Schema.Literals(CLI_OUTPUT_FORMATS),
  'text',
);

export type CliOutputFormat = typeof CliOutputFormatSchema.Type;
