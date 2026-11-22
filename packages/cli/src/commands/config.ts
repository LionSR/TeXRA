import { Settings } from '@texra-ai/worldline/plugins';
import { Effect } from 'effect';
import { Command } from 'effect/cli';

import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  CliUsageError,
  type CliContext,
  readCliAmbientState,
} from '../runtime/platform/cliContext';
import {
  cliPlatform,
  type CliPlatformServices,
} from '../runtime/platform/initPlatform';
import { writeErrorStderr } from '../runtime/platform/logSinks';

import { cliCommand } from './_helpers/cliCommand';
import { cliResult, emitCliResult } from './_helpers/output';

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

const showConfig = Effect.fn('showConfig')(function* (
  services: CliPlatformServices,
) {
  const stores = services.roots;
  const { catalog, cliRows } = TEXRA_SETTINGS;
  // Named as `.texra/config.json` spells them.
  const settings = Object.fromEntries(
    yield* Effect.forEach(cliRows, (entry) =>
      Effect.map(Settings.get(stores, entry), (value) => [
        `${catalog.namespace}.${entry.key}`,
        value,
      ]),
    ),
  );
  const record = { settings };
  yield* emitCliResult(
    cliResult(
      'config',
      record,
      Object.entries(settings)
        .map(([key, value]) => `${key}: ${formatConfigValue(value)}`)
        .join('\n'),
    ),
  );
});

const configShow = {
  config: {},
  run: Effect.fn('config.run')(function* () {
    const services = yield* cliPlatform;
    return yield* showConfig(services);
  }),
};

const configEdit = {
  config: {},
  // The terminal check is the builder's, above the program: it refuses
  // before the command's runtime is built.
  run: (context: CliContext) => {
    const ambient = readCliAmbientState();
    if (!ambient.stdinIsTty || !context.stdoutIsTty || context.termIsDumb) {
      throw new CliUsageError({
        message:
          'Interactive configuration requires a terminal. Use `texra config show` in scripts.',
      });
    }
    return Effect.gen(function* () {
      const services = yield* cliPlatform;
      // The config TUI's module is loaded lazily, so a headless `config show`
      // in the same process never pays for Ink. The TUI itself is part of
      // this program rather than a second run past a Promise edge: its Ink
      // mount is acquire/use/release-scoped, so the fiber that runs it is the
      // one that tears it down.
      const { runConfigTui } = yield* Effect.promise(
        () => import('../config/runConfigTui'),
      );
      yield* runConfigTui({
        roots: services.roots,
        runtime: services.runtime,
        colorEnabled: context.stdoutColorEnabled,
        onError: writeErrorStderr,
      });
    });
  },
};

const configShowDescription = 'Show effective CLI configuration';
const configEditDescription = 'Open the interactive configuration view';

// `texra config` on its own opens the view on a terminal and shows the
// configuration otherwise.
export const configCommand = cliCommand('config', {
  description: 'Inspect and change TeXRA configuration',
  config: {},
  run: (context: CliContext) => {
    const ambient = readCliAmbientState();
    return ambient.stdinIsTty && ambient.stdoutIsTty
      ? configEdit.run(context)
      : configShow.run();
  },
}).pipe(
  Command.withSubcommands([
    cliCommand('edit', { description: configEditDescription, ...configEdit }),
    cliCommand('show', { description: configShowDescription, ...configShow }),
  ]),
);
