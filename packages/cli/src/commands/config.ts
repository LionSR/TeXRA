import { AgentCatalog } from '@texra-ai/harness/host';
import { Settings } from '@texra-ai/harness/plugins';
import { Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';

import { agentKeyOf } from '@texra-ai/harness/schemas';

import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  CliUsageError,
  type CliContext,
  failUsage,
  readCliAmbientState,
} from '../runtime/platform/cliContext';
import { missingAgentMessage } from '../runtime/agents';
import {
  cliPlatform,
  type CliPlatformServices,
} from '../runtime/platform/initPlatform';
import { writeErrorStderr } from '../runtime/platform/logSinks';

import {
  cliCommandDefaults,
  setWorkspaceCliChatAgent,
} from '../runtime/platform/cliConfig';

import { cliCommand } from './_helpers/cliCommand';
import { cliResult, emitCliResult } from './_helpers/output';

/** The agent new chats in the project start on, as `config` reports it. */
const defaultChatAgent = (stores: CliPlatformServices['roots']) => {
  const agent = cliCommandDefaults(stores, 'chat').agent;
  return {
    record: { defaultChatAgent: agent },
    text: `Default chat agent: ${agent ?? '(automatic)'}`,
  };
};

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

const showConfig = Effect.fn('showConfig')(function* (
  services: CliPlatformServices,
) {
  const stores = services.roots;
  const agents = defaultChatAgent(stores);
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
  const record = { settings, agents: agents.record };
  yield* emitCliResult(
    cliResult(
      'config',
      record,
      [
        ...Object.entries(settings).map(
          ([key, value]) => `${key}: ${formatConfigValue(value)}`,
        ),
        '',
        agents.text,
      ].join('\n'),
    ),
  );
});

const configureDefaultAgent = Effect.fn('configureDefaultAgent')(function* (
  services: CliPlatformServices,
  input: string | undefined,
) {
  const roots = services.roots;
  const defaultAgent = input?.trim();
  if (defaultAgent === '')
    return yield* failUsage('--default-agent needs a value.');
  // The keyword reads in any case.
  if (defaultAgent?.toLowerCase() === 'none') {
    yield* setWorkspaceCliChatAgent(roots, undefined);
  } else if (defaultAgent !== undefined) {
    const available = (yield* AgentCatalog).list();
    const selected = available.find(
      (agent) =>
        agent.name === defaultAgent || agentKeyOf(agent) === defaultAgent,
    );
    if (!selected) return yield* failUsage(missingAgentMessage(defaultAgent));
    yield* setWorkspaceCliChatAgent(roots, agentKeyOf(selected));
  }
  const { record, text } = defaultChatAgent(roots);
  yield* emitCliResult(cliResult('default-agent', record, text));
});

const configAgentsCommand = cliCommand('agents', {
  description: 'Show or change the default chat agent',
  config: {
    defaultAgent: Flag.String('default-agent').pipe(
      Flag.withMetavar('agent|none'),
      Flag.withDescription(
        'The root agent new chats in this workspace start with, or none for the automatic default',
      ),
      Flag.optional,
    ),
  },
  run: Effect.fn('config.run')(function* (_context, input) {
    const services = yield* cliPlatform;
    return yield* configureDefaultAgent(
      services,
      Option.getOrUndefined(input.defaultAgent),
    );
  }),
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
          'Interactive configuration requires a terminal. Use `texra config show` or `texra config agents` in scripts.',
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
    configAgentsCommand,
  ]),
);
