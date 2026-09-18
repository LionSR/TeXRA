import { defineCommand } from 'citty';

import { getCustomAgentScanIssues } from '@agent/index';
import { loadAgentSettingAndPrompts } from '@agent/runtime';
import { AgentCategory } from '@shared/schemas';

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
import type { CliContext } from '../runtime/cliContext';

export async function listAgents(
  context: CliContext,
  options: CliAgentListOptions = {},
): Promise<number> {
  const services = await initLocalCliPlatform(context);
  const result = await services.runtime.runPromise(
    loadCliAgentList(services, options),
  );

  if (!context.quietLogs) {
    const hiddenNotice = formatCliHiddenAgentsNotice(
      result.hiddenCount,
      options.category,
    );
    if (hiddenNotice) writeTextStderr(hiddenNotice);
    for (const issue of getCustomAgentScanIssues()) {
      writeTextStderr(`Skipped custom agent ${issue.path}: ${issue.message}`);
    }
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
  const services = await initLocalCliPlatform(context);
  const entry = await services.runtime.runPromise(
    resolveCliAgent(services, name),
  );
  if (!entry) {
    writeTextStderr(missingAgentMessage(name));
    return CliExitCode.Usage;
  }

  // Everything a listed entry carries is shown as listed. The one exception
  // is a remote workflow agent's `defaultOutputFiles`: the catalog listing
  // carries none, so only loading the definition (as its launch does) shows
  // what a run would write. A tool-use agent declares none at all, so it is
  // never worth a fetch here.
  let shown = entry;
  if (entry.source === 'remote' && entry.category === AgentCategory.Workflow) {
    const [setting] = await services.runtime.runPromise(
      loadAgentSettingAndPrompts(entry),
    );
    // A scanned entry omits the field rather than carrying an empty list;
    // a loaded definition with nothing declared reads the same way.
    if (setting.defaultOutputFiles.length > 0)
      shown = { ...entry, defaultOutputFiles: setting.defaultOutputFiles };
  }

  emitCliResult(context, {
    json: shown,
    ndjson: { kind: 'agent', agent: shown },
    text: formatCliAgentDetails(shown),
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
  // Showing a remote workflow agent fetches its definition; report a failed
  // fetch as an error line and a non-zero exit, not as a CLI crash.
  catchExitCode: CliExitCode.AgentError,
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
  },
});
