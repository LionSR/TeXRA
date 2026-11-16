import { Effect, Layer } from 'effect';

import { readCliVersion } from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { emitCliResult } from './_helpers/output';

export const versionCommand = defineCliCommand({
  meta: { name: 'version', description: 'Print the CLI version' },
  // No runtime: the version is the build's, and the output format the
  // context's, read as every other command reads it. The context build
  // comes with that: a `--cwd` that does not exist is a usage error here
  // too, and an invalid setting warns on stderr before the version prints.
  layer: () => Layer.empty,
  run: () => {
    const version = readCliVersion();
    return Effect.as(
      emitCliResult({
        json: { version },
        ndjson: { kind: 'version', version },
        text: version,
      }),
      CliExitCode.Success,
    );
  },
});
