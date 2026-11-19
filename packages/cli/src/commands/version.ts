import { Effect } from 'effect';
import { Command } from 'effect/cli';

import {
  provideCliInvocation,
  readCliVersion,
} from '../runtime/platform/cliContext';

import { readCliGlobalArgs } from './_helpers/cliCommand';
import { loadConfigAndWarn } from './_helpers/loadConfigAndWarn';
import { emitCliResult } from './_helpers/output';

// No runtime: the version is the build's, and the output format the
// context's, so it prints from the parse itself.
export const versionCommand = Command.make('version', {}, () =>
  Effect.gen(function* () {
    const context = yield* loadConfigAndWarn(yield* readCliGlobalArgs());
    const version = readCliVersion();
    yield* emitCliResult({
      json: { version },
      ndjson: { kind: 'version', version },
      text: version,
    }).pipe(provideCliInvocation(context));
  }),
).pipe(Command.withDescription('Print the CLI version'));
