import { defineCommand } from 'citty';
import { Schema } from 'effect';

import {
  CliOutputFormatSchema,
  type CliOutputFormat,
} from '@texra/shared/cliOutputFormat';
import { cliEnvValue, readCliVersion } from '../runtime/platform/cliContext';

import { writeCliResult } from './_helpers/output';
import { GLOBAL_ARGS } from './_helpers/globalArgs';

const isCliOutputFormat = Schema.is(CliOutputFormatSchema);

function parseVersionOutputFormat(flagValue: unknown): CliOutputFormat {
  if (isCliOutputFormat(flagValue)) return flagValue;
  const envValue = cliEnvValue('TEXRA_OUTPUT_FORMAT')?.trim();
  return isCliOutputFormat(envValue) ? envValue : 'text';
}

export const versionCommand = defineCommand({
  meta: { name: 'version', description: 'Print the CLI version' },
  args: {
    ...GLOBAL_ARGS,
  },
  run(ctx) {
    const version = readCliVersion();
    writeCliResult(parseVersionOutputFormat(ctx.args['output-format']), {
      json: { version },
      ndjson: { kind: 'version', version },
      text: version,
    });
  },
});
