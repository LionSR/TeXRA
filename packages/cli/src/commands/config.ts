import {
  Settings,
  AgentCatalog,
  InvalidAgentTeamError,
} from '@texra-ai/harness/host';
import { defineCommand } from 'citty';
import { Effect } from 'effect';

import {
  agentKeyOf,
  type WorkspaceAgentsSelection,
} from '@texra-ai/harness/schemas';

import { workspaceTeams } from '@texra/shared/agentTeams';
import { findTeamPreset } from '@texra/shared/teamPlan';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import {
  CliUsageError,
  failUsage,
  readCliAmbientState,
} from '../runtime/cliContext';
import {
  formatCliWorkspaceAgents,
  readCliWorkspaceAgents,
} from '../runtime/workspaceAgents';
import { CliExitCode } from '../runtime/exitCodes';
import {
  initCliPlatform,
  type CliPlatformServices,
} from '../runtime/initPlatform';
import { writeErrorStderr } from '../runtime/logSinks';

import { setWorkspaceCliChatAgent } from '../runtime/cliConfig';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

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

/**
 * The agent list refuses an unknown team id in its own right; the command
 * reports that refusal as a usage error (exit 2) and leaves every other write
 * failure to the top-level handler.
 */
function asTeamUsageError<E>(error: E): E | CliUsageError {
  return error instanceof InvalidAgentTeamError
    ? new CliUsageError({ message: error.message })
    : error;
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
      Effect.map(Settings.get(stores, entry.key), (value) => [
        `${catalog.namespace}.${entry.key}`,
        value,
      ]),
    ),
  );
  const record = { settings, agents };
  yield* emitCliResult({
    json: record,
    ndjson: { kind: 'config', config: record },
    text: [
      ...Object.entries(settings).map(
        ([key, value]) => `${key}: ${formatConfigValue(value)}`,
      ),
      '',
      formatCliWorkspaceAgents(agents),
    ].join('\n'),
  });
  return CliExitCode.Success;
});

const configureWorkspaceAgents = Effect.fn('configureWorkspaceAgents')(
  function* (
    services: CliPlatformServices,
    input: {
      readonly agents?: string;
      readonly defaultTeam?: string;
      readonly defaultAgent?: string;
    },
  ) {
    const roots = services.roots;
    const workspaceAgents = (yield* AgentCatalog).workspaceAgents(roots);
    // Each value is read once, trimmed; a keyword (`inherit`, `all`, `none`,
    // the `team:` prefix) reads in any case, as a team's name does.
    const agents = input.agents?.trim();
    const defaultTeam = input.defaultTeam?.trim();
    const defaultAgent = input.defaultAgent?.trim();
    for (const [flag, value] of [
      ['--agents', agents],
      ['--default-team', defaultTeam],
      ['--default-agent', defaultAgent],
    ] as const) {
      if (value === '') return yield* failUsage(`${flag} needs a value.`);
    }
    const keyword = (value: string | undefined) => value?.toLowerCase();
    // A team is named by id, name or slug; a selection stores its id.
    const teamNamed = (query: string) =>
      Effect.map(workspaceTeams(roots.repoState), (teams) =>
        findTeamPreset(teams, query),
      );

    if (agents !== undefined) {
      const kind = keyword(agents);
      let selection: WorkspaceAgentsSelection;
      if (kind === 'inherit' || kind === 'all') selection = { kind };
      else if (kind?.startsWith('team:')) {
        const query = agents.slice('team:'.length).trim();
        if (query === '')
          return yield* failUsage('--agents team: needs a team.');
        const team = yield* teamNamed(query);
        if (!team) return yield* failUsage(`Unknown agent team: ${query}`);
        selection = { kind: 'team', teamId: team.id };
      } else selection = { kind: 'custom', agentKeys: parseAgentKeys(agents) };
      yield* workspaceAgents
        .select(selection)
        .pipe(Effect.mapError(asTeamUsageError));
    }

    if (keyword(defaultTeam) === 'none')
      yield* workspaceAgents.setDefaultTeam(undefined);
    else if (defaultTeam !== undefined) {
      const team = yield* teamNamed(defaultTeam);
      if (!team) return yield* failUsage(`Unknown agent team: ${defaultTeam}`);
      // Only a built-in team can be the user default: a saved team belongs to
      // one workspace.
      if (team.source !== 'built-in') {
        return yield* failUsage(
          `Only a built-in team can be the user default: ${defaultTeam}`,
        );
      }
      yield* workspaceAgents
        .setDefaultTeam(team.id)
        .pipe(Effect.mapError(asTeamUsageError));
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
    yield* emitCliResult({
      json: record,
      ndjson: { kind: 'workspace-agents', agents: record },
      text: formatCliWorkspaceAgents(record),
    });
    return CliExitCode.Success;
  },
);

const configAgentsCommand = defineCliCommand({
  meta: {
    name: 'agents',
    description: 'Show or change the workspace agents',
  },
  args: {
    ...GLOBAL_ARGS,
    agents: {
      type: 'string',
      valueHint: 'inherit|all|team:<team>|agent,...',
      description:
        'The workspace agents: the user default (inherit), every agent (all), a team by id, name or slug, or an exact comma-separated agent list',
    },
    'default-team': {
      type: 'string',
      valueHint: 'team|none',
      description:
        'The user default team that inherited workspaces use, or none to clear it',
    },
    'default-agent': {
      type: 'string',
      valueHint: 'agent|none',
      description:
        'The root agent new chats in this workspace start with, or none for the automatic default',
    },
  },
  run: Effect.fn('config.run')(function* (context, ctx) {
    const services = yield* initCliPlatform(context);
    return yield* configureWorkspaceAgents(services, {
      agents: optString(ctx.args.agents),
      defaultTeam: optString(ctx.args['default-team']),
      defaultAgent: optString(ctx.args['default-agent']),
    });
  }),
});

const configShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show effective CLI configuration' },
  args: { ...GLOBAL_ARGS },
  run: Effect.fn('config.run')(function* (context) {
    const services = yield* initCliPlatform(context);
    return yield* showConfig(services);
  }),
});

const configEditCommand = defineCliCommand({
  meta: {
    name: 'edit',
    description: 'Open the interactive configuration view',
  },
  args: { ...GLOBAL_ARGS },
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
      const services = yield* initCliPlatform(context);
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
      return CliExitCode.Success;
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
