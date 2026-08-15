import { defineCommand } from 'citty';

import {
  createWorkspaceAgentRosterController,
  InvalidAgentTeamError,
} from '@agent/index';
import { agentKeyOf, CLI_STATE_SETTINGS } from '@shared/schemas';
import { readSetting } from '@shared/config/settingsAccess';
import { unique } from '@utils/core';

import {
  CliUsageError,
  readCliAmbientState,
  type CliContext,
} from '../runtime/cliContext';
import {
  formatCliAgentRoster,
  readCliAgentRoster,
} from '../runtime/agentRoster';
import { CliExitCode } from '../runtime/exitCodes';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { writeErrorStderr } from '../runtime/logSinks';
import { setWorkspaceCliChatAgent } from '../runtime/cliConfig';
import { cliSettingsStores } from '../runtime/settingsStores';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

function parseAgentKeys(value: string | undefined): string[] {
  if (!value) return [];
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

async function runAgentRosterTeamAction(
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    if (error instanceof InvalidAgentTeamError) {
      throw new CliUsageError(error.message);
    }
    throw error;
  }
}

async function showConfig(context: CliContext): Promise<number> {
  await initLocalCliPlatform(context);
  const agents = await readCliAgentRoster();
  const stores = cliSettingsStores();
  const settings = Object.fromEntries(
    CLI_STATE_SETTINGS.map((entry) => [
      entry.key,
      readSetting(entry, stores, 'cli'),
    ]),
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
}

async function configureAgentRoster(
  context: CliContext,
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
): Promise<number> {
  await initLocalCliPlatform(context);
  await readCliAgentRoster();
  const roster = createWorkspaceAgentRosterController();
  const customRequested =
    input.workflow !== undefined || input.toolUse !== undefined;
  const workspaceChoices = [
    input.inherit,
    input.all,
    Boolean(input.team),
    customRequested,
  ].filter(Boolean).length;
  if (workspaceChoices > 1) {
    throw new CliUsageError(
      'Choose one workspace roster: --inherit, --all, --team, or the custom --workflow/--tool-use lists.',
    );
  }
  if (input.defaultTeam && input.clearDefault) {
    throw new CliUsageError(
      'Use either --default-team or --clear-default, not both.',
    );
  }
  if (input.defaultAgent && input.clearDefaultAgent) {
    throw new CliUsageError(
      'Use either --default-agent or --clear-default-agent, not both.',
    );
  }

  if (input.inherit) await roster.setInherited();
  if (input.all) await roster.setAll();
  const teamId = input.team;
  if (teamId) {
    await runAgentRosterTeamAction(() => roster.setTeam(teamId));
  }
  if (input.workflow !== undefined && input.toolUse !== undefined) {
    await roster.setCustom({
      workflow: parseAgentKeys(input.workflow),
      toolUse: parseAgentKeys(input.toolUse),
    });
  } else if (input.workflow !== undefined) {
    await roster.setEnabledAgentKeys(
      'workflow',
      parseAgentKeys(input.workflow),
    );
  } else if (input.toolUse !== undefined) {
    await roster.setEnabledAgentKeys('toolUse', parseAgentKeys(input.toolUse));
  }
  const defaultTeamId = input.defaultTeam;
  if (defaultTeamId) {
    await runAgentRosterTeamAction(() => roster.setDefaultTeam(defaultTeamId));
  }
  if (input.clearDefault) await roster.clearDefaultTeam();
  if (input.defaultAgent) {
    const available = roster.getVisibleAgents('toolUse');
    const selected = available.find(
      (agent) =>
        agent.name === input.defaultAgent ||
        agentKeyOf(agent) === input.defaultAgent,
    );
    if (!selected) {
      const names = available.map((agent) => agent.name).join(', ');
      throw new CliUsageError(
        `Default chat agent "${input.defaultAgent}" is not in the effective workspace roster. Available agents: ${names || '(none)'}.`,
      );
    }
    await setWorkspaceCliChatAgent(context.cwd, agentKeyOf(selected));
  }
  if (input.clearDefaultAgent) {
    await setWorkspaceCliChatAgent(context.cwd, undefined);
  }

  const record = await readCliAgentRoster();
  emitCliResult(context, {
    json: record,
    ndjson: { kind: 'agent-roster', roster: record },
    text: formatCliAgentRoster(record),
  });
  return CliExitCode.Success;
}

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
    all: { type: 'boolean', description: 'Show every agent' },
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
    configureAgentRoster(context, {
      inherit: ctx.args.inherit === true,
      all: ctx.args.all === true,
      team: optString(ctx.args.team),
      workflow: optString(ctx.args.workflow),
      toolUse: optString(ctx.args['tool-use']),
      defaultTeam: optString(ctx.args['default-team']),
      clearDefault: ctx.args['clear-default'] === true,
      defaultAgent: optString(ctx.args['default-agent']),
      clearDefaultAgent: ctx.args['clear-default-agent'] === true,
    }),
});

const configShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show effective CLI configuration' },
  args: { ...GLOBAL_ARGS },
  run: showConfig,
});

const configEditCommand = defineCliCommand({
  meta: {
    name: 'edit',
    description: 'Open the interactive configuration view',
  },
  args: { ...GLOBAL_ARGS },
  run: async (context) => {
    const ambient = readCliAmbientState();
    if (!ambient.stdinIsTty || !context.stdoutIsTty || context.termIsDumb) {
      throw new CliUsageError(
        'Interactive configuration requires a terminal. Use `texra config show` or `texra config agents` in scripts.',
      );
    }
    await initLocalCliPlatform(context);
    const { runConfigTui } = await import('../config/runConfigTui');
    await runConfigTui({
      colorEnabled: context.stdoutColorEnabled,
      onError: writeErrorStderr,
    });
    return CliExitCode.Success;
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
