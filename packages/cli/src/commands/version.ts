import { defineCommand } from 'citty';

import { cliEnvValue, readCliVersion } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';

import { emitCliResult } from './_helpers/output';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import {
  CLI_OUTPUT_FORMATS,
  type CliOutputFormat,
} from '../schemas/cliSettings';

function isCliOutputFormat(value: unknown): value is CliOutputFormat {
  return (
    typeof value === 'string' &&
    (CLI_OUTPUT_FORMATS as readonly string[]).includes(value)
  );
}

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
  async run(ctx) {
    const version = await readCliVersion();
    emitCliResult(
      { outputFormat: parseVersionOutputFormat(ctx.args['output-format']) },
      {
        json: { version },
        ndjson: { kind: 'version', version },
        text: version,
      },
    );
    setExitCode(CliExitCode.Success);
  },
});
