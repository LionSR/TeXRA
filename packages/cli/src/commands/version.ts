import { Effect, Layer } from 'effect';

import { readCliVersion } from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

export const versionCommand = defineCliCommand({
  meta: { name: 'version', description: 'Print the CLI version' },
  args: {
    ...GLOBAL_ARGS,
  },
  // No runtime: the version is the build's, and the output format the
  // context's, read as every other command reads it.
  layer: () => Layer.empty,
  run: () =>
    Effect.sync(() => {
      const version = readCliVersion();
      emitCliResult({
        json: { version },
        ndjson: { kind: 'version', version },
        text: version,
      });
      return CliExitCode.Success;
    }),
});
