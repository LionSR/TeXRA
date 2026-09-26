import { Effect, Layer } from 'effect';

import { buildCliContext, type CliContext } from '@cli/runtime/cliContext';
import { pickGlobalArgs, type ParsedGlobalArgs } from '@cli/runtime/globalArgs';
import { writeTextStderr } from '@cli/runtime/logSinks';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import { processEnvConfigLayer } from '@utils/system/envFlags';

import { collectStringFlagValues } from './globalArgs';

/**
 * The CLI's one pre-runtime run, and the citty actions' Promise face. The
 * context program opens the project and user `config.json` stores BEFORE
 * `initCliPlatform` (and with it `installCliProcessRuntime`), so there is no
 * process runtime to borrow yet; it needs the filesystem and the process
 * environment (as a ConfigProvider). The run provides the Node file services
 * (the `--cwd` check) and the same env ConfigProvider the process runtime
 * serves, so the context's env tier reads the live process environment.
 * Pinned in `BARE_EFFECT_RUN_SITES`.
 */
export function contextFromArgs(
  args: ParsedGlobalArgs,
  rawArgs: readonly string[] = [],
  /** `texra doctor` reports the config warnings in its own Config row. */
  options: { readonly printConfigWarnings?: boolean } = {},
): Promise<CliContext> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* buildCliContext({
        // Raw argv is the only reader that survives repeated `--source/-s`:
        // citty's parsed args keep the last value only.
        globalArgs: pickGlobalArgs(args, {
          skillSourcePaths: collectStringFlagValues(rawArgs, 'source', 's'),
        }),
      });
      // Degradation reaches stderr even under `--quiet` (#11080).
      const printed = context.quietLogs
        ? context.configDegradations
        : [...context.configDegradations, ...context.configWarnings];
      if (options.printConfigWarnings !== false) {
        for (const warning of printed) writeTextStderr(`WARN ${warning}`);
      }
      return context;
    }).pipe(
      Effect.provide(Layer.merge(nodeFileServices, processEnvConfigLayer)),
    ),
  );
}
