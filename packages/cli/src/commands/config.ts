import { defineCommand } from 'citty';
import { Effect } from 'effect';

import {
  createWorkspaceAgentRosterController,
  InvalidAgentTeamError,
  loadAgents,
} from '@agent/index';
import { agentKeyOf } from '@shared/schemas';
import { CLI_STATE_SETTINGS } from '@shared/state/stateSettings';
import { readSetting } from '@shared/config/settingsAccess';
import { unique } from '@utils/core';

import {
  CliUsageError,
  failUsage,
  readCliAmbientState,
  type CliContext,
} from '../runtime/cliContext';
import {
  formatCliAgentRoster,
  readCliAgentRoster,
} from '../runtime/agentRoster';
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

function parseAgentKeys(value = ''): string[] {
  return unique(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

/**
 * The roster refuses an unknown or non-built-in team id in its own right; the
 * command reports that refusal as a usage error (exit 2) and leaves every
 * other write failure to the top-level handler.
 */
function asTeamUsageError<E>(error: E): E | CliUsageError {
  return error instanceof InvalidAgentTeamError
    ? new CliUsageError(error.message)
    : error;
}

const showConfig = Effect.fn('showConfig')(function* (
  context: CliContext,
  services: CliPlatformServices,
) {
  const stores = services.roots;
  const agents = yield* readCliAgentRoster(stores);
  const settings = Object.fromEntries(
    yield* Effect.forEach(CLI_STATE_SETTINGS, (entry) =>
      Effect.map(readSetting(entry, stores, 'cli'), (value) => [
        entry.key,
        value,
      ]),
    ),
  );
  const record = { settings, agents };
  emitCliResult(context, {
    json: record,
    ndjson: { kind: 'config', config: record },
    text: [
      ...Object.entries(settings).map(
        ([key, value]) => `${key}: ${formatConfigValue(value)}`,
      ),
      '',
      formatCliAgentRoster(agents),
    ].join('\n'),
  });
  return CliExitCode.Success;
});

const configureAgentRoster = Effect.fn('configureAgentRoster')(function* (
  context: CliContext,
  services: CliPlatformServices,
  input: {
    readonly inherit: boolean;
    readonly all: boolean;
    readonly team?: string;
    readonly workflow?: string;
    readonly toolUse?: string;
    readonly defaultTeam?: string;
    readonly clearDefault: boolean;
    readonly defaultAgent?: string;
    readonly clearDefaultAgent: boolean;
  },
) {
  const roots = services.roots;
  // The controller below resolves agent keys, so the registry must be loaded
  // first; the honest roster read happens once, later, where it is emitted.
  yield* loadAgents({ includeRemote: false });
  const roster = createWorkspaceAgentRosterController(roots);
  const customRequested =
    input.workflow !== undefined || input.toolUse !== undefined;
  const workspaceChoices = [
    input.inherit,
    input.all,
    Boolean(input.team),
    customRequested,
  ].filter(Boolean).length;
  if (workspaceChoices > 1) {
    return yield* failUsage(
      'Choose one workspace roster: --inherit, --all, --team, or the custom --workflow/--tool-use lists.',
    );
  }
  if (input.defaultTeam && input.clearDefault) {
    return yield* failUsage(
      'Use either --default-team or --clear-default, not both.',
    );
  }
  if (input.defaultAgent && input.clearDefaultAgent) {
    return yield* failUsage(
      'Use either --default-agent or --clear-default-agent, not both.',
    );
  }

  if (input.inherit) yield* roster.setInherited();
  if (input.all) yield* roster.setAll();
  const teamId = input.team;
  if (teamId) {
    yield* roster.setTeam(teamId).pipe(Effect.mapError(asTeamUsageError));
  }
  if (input.workflow !== undefined && input.toolUse !== undefined) {
    yield* roster.setCustom({
      workflow: parseAgentKeys(input.workflow),
      toolUse: parseAgentKeys(input.toolUse),
    });
  } else if (input.workflow !== undefined) {
    yield* roster.setEnabledAgentKeys(
      'workflow',
      parseAgentKeys(input.workflow),
    );
  } else if (input.toolUse !== undefined) {
    yield* roster.setEnabledAgentKeys('toolUse', parseAgentKeys(input.toolUse));
  }
  const defaultTeamId = input.defaultTeam;
  if (defaultTeamId) {
    yield* roster
      .setDefaultTeam(defaultTeamId)
      .pipe(Effect.mapError(asTeamUsageError));
  }
  if (input.clearDefault) yield* roster.clearDefaultTeam();
  if (input.defaultAgent) {
    const available = yield* roster.getVisibleAgents('toolUse');
    const selected = available.find(
      (agent) =>
        agent.name === input.defaultAgent ||
        agentKeyOf(agent) === input.defaultAgent,
    );
    if (!selected) {
      const names = available.map((agent) => agent.name).join(', ');
      return yield* failUsage(
        `Default chat agent "${input.defaultAgent}" is not in the effective workspace roster. Available agents: ${names || '(none)'}.`,
      );
    }
    yield* setWorkspaceCliChatAgent(roots, agentKeyOf(selected));
  }
  if (input.clearDefaultAgent) {
    yield* setWorkspaceCliChatAgent(roots, undefined);
  }

  const record = yield* readCliAgentRoster(roots);
  emitCliResult(context, {
    json: record,
    ndjson: { kind: 'agent-roster', roster: record },
    text: formatCliAgentRoster(record),
  });
  return CliExitCode.Success;
});

const configAgentsCommand = defineCliCommand({
  meta: {
    name: 'agents',
    description: 'Show or change the workspace agent roster',
  },
  args: {
    ...GLOBAL_ARGS,
    inherit: {
      type: 'boolean',
      description: 'Use the user default team, or all agents when none is set',
    },
    all: {
      type: 'boolean',
      description: 'Set this workspace roster to every agent',
    },
    team: { type: 'string', description: 'Use a built-in or saved team id' },
    workflow: {
      type: 'string',
      valueHint: 'agent,...',
      description: 'Use an exact comma-separated workflow-agent list',
    },
    'tool-use': {
      type: 'string',
      valueHint: 'agent,...',
      description: 'Use an exact comma-separated tool-use-agent list',
    },
    'default-team': {
      type: 'string',
      description: 'Set the user default team used by inherited workspaces',
    },
    'clear-default': {
      type: 'boolean',
      description: 'Clear the user default team',
    },
    'default-agent': {
      type: 'string',
      description: 'Set the default root agent for chats in this workspace',
    },
    'clear-default-agent': {
      type: 'boolean',
      description: 'Return chat-agent selection to the automatic default',
    },
  },
  run: (context, ctx) =>
    Effect.gen(function* () {
      const services = yield* initCliPlatform({
        ...context,
        quietLogs: true,
      });
      return yield* configureAgentRoster(context, services, {
        inherit: ctx.args.inherit === true,
        all: ctx.args.all === true,
        team: optString(ctx.args.team),
        workflow: optString(ctx.args.workflow),
        toolUse: optString(ctx.args['tool-use']),
        defaultTeam: optString(ctx.args['default-team']),
        clearDefault: ctx.args['clear-default'] === true,
        defaultAgent: optString(ctx.args['default-agent']),
        clearDefaultAgent: ctx.args['clear-default-agent'] === true,
      });
    }),
});

const configShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show effective CLI configuration' },
  args: { ...GLOBAL_ARGS },
  run: (context) =>
    Effect.gen(function* () {
      const services = yield* initCliPlatform({
        ...context,
        quietLogs: true,
      });
      return yield* showConfig(context, services);
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
      throw new CliUsageError(
        'Interactive configuration requires a terminal. Use `texra config show` or `texra config agents` in scripts.',
      );
    }
    return Effect.gen(function* () {
      const services = yield* initCliPlatform({ ...context, quietLogs: true });
      // The config TUI's module is loaded lazily, so a headless `config show`
      // in the same process never pays for Ink. The TUI itself is part of
      // this program rather than a second run past a Promise edge: its Ink
      // mount is acquire/use/release-scoped, so the fiber that runs it is the
      // one that tears it down.
      const { runConfigTui } = yield* Effect.promise(
        () => import('../config/runConfigTui'),
      );
      yield* runConfigTui({
        stores: services.roots,
        secrets: services.secrets,
        runtime: services.runtime,
        workspaceRoot: services.roots.workspace,
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
