import { Effect } from 'effect';

import { nodeFileServices } from '@texra-ai/harness/node';
import { buildCliContext } from '@cli/runtime/cliContext';
import { writeTextStderr } from '@cli/runtime/logSinks';

import { pickGlobalArgs, type ParsedGlobalArgs } from './globalArgs';

/**
 * The CLI's pre-runtime context program. It opens the project and user
 * `config.json` stores BEFORE `initCliPlatform` (and with it
 * `installCliProcessRuntime`), so there is no process runtime to borrow yet;
 * it needs the filesystem and the process environment (as a ConfigProvider),
 * which it provides itself: the Node file services (the `--cwd` check) and the
 * same env ConfigProvider the process runtime serves, so the context's env
 * tier reads the live process environment. A citty action runs it once
 * (`defineCliCommand`, and `texra doctor` inside its own program); pinned in
 * `BARE_EFFECT_RUN_SITES`.
 */
export function contextFromArgs(
  args: ParsedGlobalArgs,
  rawArgs: readonly string[] = [],
  /** `texra doctor` reports the config warnings in its own Config row. */
  options: { readonly printConfigWarnings?: boolean } = {},
) {
  return Effect.gen(function* () {
    const context = yield* buildCliContext({
      globalArgs: pickGlobalArgs(args, rawArgs),
    });
    // Degradation reaches stderr even under `--quiet` (#11080).
    const printed = context.quietLogs
      ? context.configDegradations
      : [...context.configDegradations, ...context.configWarnings];
    if (options.printConfigWarnings !== false) {
      for (const warning of printed) writeTextStderr(`WARN ${warning}`);
    }
    return context;
  }).pipe(Effect.provide(nodeFileServices));
}
