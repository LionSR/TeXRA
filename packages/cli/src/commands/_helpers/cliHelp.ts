// Third-party imports
import { Effect, Layer } from 'effect';
import { CliOutput } from 'effect/cli';

// Local imports - CLI
import {
  writeTextStderr,
  writeTextStdout,
} from '@cli/runtime/platform/logSinks';

/**
 * Where effect/cli's own help, usage-error and version text goes: help and
 * the version to stdout, a usage error (its message and the help it refers
 * to) to stderr, so stdout stays clean under `--output-format json|ndjson`.
 */
export const cliPresenterLayer = (colors: boolean) => {
  const formatter = CliOutput.defaultFormatter({ colors });
  return Layer.succeed(CliOutput.Presenter)({
    present: (event) =>
      Effect.sync(() => {
        switch (event._tag) {
          case 'Help':
            writeTextStdout(formatter.formatHelpDoc(event.helpDoc));
            return;
          case 'InvalidInvocation':
            writeTextStderr(
              `${formatter.formatHelpDoc(event.helpDoc)}\n${formatter.formatErrors(event.errors)}`,
            );
            return;
          case 'Version':
            writeTextStdout(formatter.formatVersion(event.name, event.version));
        }
      }),
  });
};
