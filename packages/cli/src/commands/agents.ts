import { defineCommand } from 'citty';

import {
  getAgent,
  getToolUseAgents,
  getVisibleAgents,
  getWorkflowAgents,
  loadAgents,
} from '@agent/index';
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { CliExitCode } from '../runtime/exitCodes';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';

import {
  AGENT_NAME_DESCRIPTION,
  missingAgentMessage,
} from './_helpers/agentLookupText';
import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { resolveAgentWithRemoteFallback } from './_helpers/remoteAgents';
import { agentsRunCommand } from './agentsRun';
import type { CliContext } from '../runtime/cliContext';

interface ListAgentsOptions {
  readonly includeHidden?: boolean;
}

function collectAgents(
  source: 'all' | 'visible',
): (AgentEntry & { readonly category: AgentCategory })[] {
  const byCategory =
    source === 'all'
      ? {
          [AgentCategory.Workflow]: getWorkflowAgents(),
          [AgentCategory.ToolUse]: getToolUseAgents(),
        }
      : {
          [AgentCategory.Workflow]: getVisibleAgents(AgentCategory.Workflow),
          [AgentCategory.ToolUse]: getVisibleAgents(AgentCategory.ToolUse),
        };

  return [AgentCategory.Workflow, AgentCategory.ToolUse].flatMap((category) =>
    byCategory[category].map((agent) => ({ ...agent, category })),
  );
}

function formatAgentListText(
  agents: readonly (AgentEntry & { readonly category: AgentCategory })[],
): string {
  return agents
    .map(
      (agent) => `${agent.category}\t${agent.name}\t${agent.description ?? ''}`,
    )
    .join('\n');
}

export async function listAgents(
  context: CliContext,
  options: ListAgentsOptions = {},
): Promise<number> {
  await initLocalCliPlatform(context);
  const includeHidden = options.includeHidden === true;
  await loadAgents(includeHidden ? undefined : { includeRemote: false });
  const agents = collectAgents(includeHidden ? 'all' : 'visible');

  if (!includeHidden && context.outputFormat === 'text') {
    const hiddenCount = collectAgents('all').length - agents.length;
    if (hiddenCount > 0) {
      writeTextStderr(
        `Showing visible agents only; ${hiddenCount} hidden agent${hiddenCount === 1 ? '' : 's'} omitted. Use \`texra agents list --all\` to show the full catalog.`,
      );
    }
  }

  emitCliResult(
    context,
    {
      json: agents,
      ndjson: agents.map((agent) => ({ kind: 'agent', agent })),
      text: formatAgentListText(agents),
    },
    { paged: true },
  );
  return CliExitCode.Success;
}

function formatAgentDetails(entry: AgentEntry): string {
  const lines: string[] = [];
  lines.push(`name: ${entry.name}`);
  lines.push(`category: ${entry.category}`);
  lines.push(`source: ${entry.source}`);
  if (entry.path) lines.push(`path: ${entry.path}`);
  if (entry.description) {
    lines.push('');
    lines.push(entry.description);
  }
  const metadataLines: string[] = [];
  if (entry.tools && entry.tools.length > 0) {
    metadataLines.push(`tools: ${entry.tools.join(', ')}`);
  }
  if (entry.defaultOutputFiles && entry.defaultOutputFiles.length > 0) {
    metadataLines.push(
      `defaultOutputFiles: ${entry.defaultOutputFiles.join(', ')}`,
    );
  }
  if (entry.visibility && entry.visibility.length > 0) {
    metadataLines.push(`visibility: ${entry.visibility.join(', ')}`);
  }
  if (metadataLines.length > 0) {
    lines.push('');
    lines.push(...metadataLines);
  }
  return lines.join('\n');
}

export async function showAgent(
  context: CliContext,
  name: string,
): Promise<number> {
  await initLocalCliPlatform(context);
  await loadAgents({ includeRemote: false });

  const entry = getAgent(name) ?? (await resolveAgentWithRemoteFallback(name));
  if (!entry) {
    writeTextStderr(missingAgentMessage(name));
    return CliExitCode.Usage;
  }

  emitCliResult(context, {
    json: entry,
    ndjson: { kind: 'agent', agent: entry },
    text: formatAgentDetails(entry),
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
        'Show the full agent catalog, including agents hidden by workspace visibility settings',
    },
  },
  run: (context, ctx) =>
    listAgents(context, { includeHidden: ctx.args.all === true }),
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
  subCommands: {
    list: agentsListCommand,
    show: agentsShowCommand,
    run: agentsRunCommand,
  },
});
