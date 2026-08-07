import { defineCommand } from 'citty';

import { loadAgents } from '@agent/index';

import {
  AGENT_NAME_DESCRIPTION,
  CLI_AGENT_CATEGORY_FILTER_VALUES,
  formatCliAgentDetails,
  formatCliAgentList,
  formatCliHiddenAgentsNotice,
  loadCliAgentList,
  missingAgentMessage,
  parseCliAgentCategoryFilter,
  resolveCliAgent,
  type CliAgentListOptions,
} from '../runtime/agents';
import { CliExitCode } from '../runtime/exitCodes';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { agentsRunCommand } from './agentsRun';
import type { CliContext } from '../runtime/cliContext';

export async function listAgents(
  context: CliContext,
  options: CliAgentListOptions = {},
): Promise<number> {
  await initLocalCliPlatform(context);
  if (options.includeHidden !== true) {
    await loadAgents({ includeRemote: false });
  }
  const result = await loadCliAgentList(options);

  if (!context.quietLogs) {
    const hiddenNotice = formatCliHiddenAgentsNotice(
      result.hiddenCount,
      options.category,
    );
    if (hiddenNotice) writeTextStderr(hiddenNotice);
  }

  emitCliResult(
    context,
    {
      json: result.agents,
      ndjson: result.agents.map((agent) => ({ kind: 'agent', agent })),
      text: formatCliAgentList(result.agents, {
        category: options.category,
        showEmptyState:
          options.includeHidden !== true &&
          !context.quietLogs &&
          context.outputFormat === 'text',
      }),
    },
    { paged: true },
  );
  return CliExitCode.Success;
}

export async function showAgent(
  context: CliContext,
  name: string,
): Promise<number> {
  await initLocalCliPlatform(context);
  const entry = await resolveCliAgent(name);
  if (!entry) {
    writeTextStderr(missingAgentMessage(name));
    return CliExitCode.Usage;
  }

  emitCliResult(context, {
    json: entry,
    ndjson: { kind: 'agent', agent: entry },
    text: formatCliAgentDetails(entry),
  });
  return CliExitCode.Success;
}

const agentsListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List available agents' },
  args: {
    ...GLOBAL_ARGS,
    all: {
      type: 'boolean',
      description:
        'Show every agent, including agents hidden by workspace visibility settings',
    },
    category: {
      type: 'enum',
      options: CLI_AGENT_CATEGORY_FILTER_VALUES,
      description:
        'Only list one category: workflow or toolUse (also accepts tool-use/tool_use)',
    },
  },
  run: (context, ctx) =>
    listAgents(context, {
      includeHidden: ctx.args.all === true,
      category: parseCliAgentCategoryFilter(optString(ctx.args.category)),
    }),
});

const agentsShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one agent' },
  args: {
    ...GLOBAL_ARGS,
    name: {
      type: 'positional',
      required: true,
      description: `${AGENT_NAME_DESCRIPTION} (use \`source:name\` to disambiguate when the same name exists in multiple sources)`,
    },
  },
  run: (context, ctx) => showAgent(context, ctx.args.name),
});

export const agentsCommand = defineCommand({
  meta: { name: 'agents', description: 'Inspect TeXRA agents' },
  // `show` already prints everything about an agent, so there is no separate
  // `inspect` verb here (unlike `multi-agent show`, which resolves a team run
  // plan).
  subCommands: {
    list: agentsListCommand,
    show: agentsShowCommand,
    run: agentsRunCommand,
  },
});
