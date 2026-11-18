import { AgentCatalog } from '@texra-ai/harness/host';
import { Settings } from '@texra-ai/harness/plugins';
import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { agentKeyOf } from '@texra-ai/harness/schemas';

import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  CliUsageError,
  failUsage,
  readCliAmbientState,
} from '../runtime/platform/cliContext';
import { missingAgentMessage } from '../runtime/agents';
import {
  formatCliWorkspaceAgents,
  readCliWorkspaceAgents,
} from '../runtime/workspaceAgents';
import {
  cliPlatform,
  type CliPlatformServices,
} from '../runtime/platform/initPlatform';
import { writeErrorStderr } from '../runtime/platform/logSinks';

import { setWorkspaceCliChatAgent } from '../runtime/platform/cliConfig';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { optString } from './_helpers/globalArgs';
import { cliResult, emitCliResult } from './_helpers/output';

function parseAgentKeys(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

const showConfig = Effect.fn('showConfig')(function* (
  services: CliPlatformServices,
) {
  const stores = services.roots;
  const agents = yield* readCliWorkspaceAgents(stores);
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
  const record = { settings, agents };
  yield* emitCliResult(
    cliResult(
      'config',
      record,
      [
        ...Object.entries(settings).map(
          ([key, value]) => `${key}: ${formatConfigValue(value)}`,
        ),
        '',
        formatCliWorkspaceAgents(agents),
      ].join('\n'),
    ),
  );
});

const configureWorkspaceAgents = Effect.fn('configureWorkspaceAgents')(
  function* (
    services: CliPlatformServices,
    input: {
      readonly agents?: string;
      readonly defaultAgent?: string;
    },
  ) {
    const roots = services.roots;
    const catalog = yield* AgentCatalog;
    const workspaceAgents = catalog.workspaceAgents(roots);
    // Each value is read once, trimmed; a keyword (`all`, `none`) reads in
    // any case.
    const agents = input.agents?.trim();
    const defaultAgent = input.defaultAgent?.trim();
    for (const [flag, value] of [
      ['--agents', agents],
      ['--default-agent', defaultAgent],
    ] as const) {
      if (value === '') return yield* failUsage(`${flag} needs a value.`);
    }
    const keyword = (value: string | undefined) => value?.toLowerCase();

    if (keyword(agents) === 'all') {
      yield* workspaceAgents.select({ kind: 'all' });
    } else if (agents !== undefined) {
      const agentKeys = parseAgentKeys(agents);
      // A list replaces every agent it does not name, so one holding a name
      // no agent has would only narrow the workspace: nothing is stored.
      const unknown = agentKeys.filter((key) => catalog.get(key) === undefined);
      if (unknown.length > 0) {
        return yield* failUsage(missingAgentMessage(unknown.join(', ')));
      }
      yield* workspaceAgents.select({ kind: 'custom', agentKeys });
    }

    if (keyword(defaultAgent) === 'none') {
      yield* setWorkspaceCliChatAgent(roots, undefined);
    } else if (defaultAgent !== undefined) {
      const available = yield* workspaceAgents.visible();
      const selected = available.find(
        (agent) =>
          agent.name === defaultAgent || agentKeyOf(agent) === defaultAgent,
      );
      if (!selected) {
        const names = available.map((agent) => agent.name).join(', ');
        return yield* failUsage(
          `Default chat agent "${defaultAgent}" is not in the workspace agents. Available agents: ${names || '(none)'}.`,
        );
      }
      yield* setWorkspaceCliChatAgent(roots, agentKeyOf(selected));
    }

    const record = yield* readCliWorkspaceAgents(roots);
    yield* emitCliResult(
      cliResult('workspace-agents', record, formatCliWorkspaceAgents(record)),
    );
  },
);

const configAgentsCommand = defineCliCommand({
  meta: {
    name: 'agents',
    description: 'Show or change the workspace agents',
  },
  args: {
    agents: {
      type: 'string',
      valueHint: 'all|agent,...',
      description:
        'The workspace agents: every agent (all), or an exact comma-separated agent list',
    },
    'default-agent': {
      type: 'string',
      valueHint: 'agent|none',
      description:
        'The root agent new chats in this workspace start with, or none for the automatic default',
    },
  },
  run: Effect.fn('config.run')(function* (context, ctx) {
    const services = yield* cliPlatform;
    return yield* configureWorkspaceAgents(services, {
      agents: optString(ctx.args.agents),
      defaultAgent: optString(ctx.args['default-agent']),
    });
  }),
});

const configShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show effective CLI configuration' },
  run: Effect.fn('config.run')(function* () {
    const services = yield* cliPlatform;
    return yield* showConfig(services);
  }),
});

const configEditCommand = defineCliCommand({
  meta: {
    name: 'edit',
    description: 'Open the interactive configuration view',
  },
  // The terminal check is the builder's, above the program: it refuses
  // before `defineCliCommand` installs anything.
  run: (context) => {
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
});

export const configCommand = defineCommand({
  meta: {
    name: 'config',
    description: 'Inspect and change TeXRA configuration',
  },
  subCommands: {
    edit: configEditCommand,
    show: configShowCommand,
    agents: configAgentsCommand,
  },
  default: () => {
    const ambient = readCliAmbientState();
    return ambient.stdinIsTty && ambient.stdoutIsTty ? 'edit' : 'show';
  },
});
