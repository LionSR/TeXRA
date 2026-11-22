import { Effect } from 'effect';

import { nodeFileServices } from '@texra-ai/worldline/node';
import {
  buildCliContext,
  isQuiet,
  type CliGlobalArgs,
} from '@cli/runtime/platform/cliContext';
import { writeTextStderr } from '@cli/runtime/platform/logSinks';

/**
 * The CLI's pre-runtime context program. It opens the project and user
 * `config.json` stores BEFORE the command's runtime is
 * built, so there is no process runtime to borrow yet;
 * it needs the filesystem and the process environment (as a ConfigProvider),
 * which it provides itself: the Node file services (the `--cwd` check) and the
 * same env ConfigProvider the process runtime serves, so the context's env
 * tier reads the live process environment. A command's handler runs it
 * once, in the parse (`selectCliCommand`, and `texra doctor` for its report).
 */
export const loadConfigAndWarn = Effect.fn('loadConfigAndWarn')(function* (
  globalArgs: CliGlobalArgs,
  options: { readonly printConfigWarnings?: boolean } = {},
) {
  const context = yield* buildCliContext({
    globalArgs,
  });
  // Degradation reaches stderr even under `--quiet` (#11080).
  const printed = isQuiet(context)
    ? context.configDegradations
    : [...context.configDegradations, ...context.configWarnings];
  if (options.printConfigWarnings !== false) {
    for (const warning of printed) writeTextStderr(`WARN ${warning}`);
  }
  return context;
}, Effect.provide(nodeFileServices));
