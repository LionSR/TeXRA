import { defineCommand } from 'citty';

import { getAgent, getVisibleAgents, loadAgents } from '@agent/index';
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { CliExitCode } from '../runtime/exitCodes';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { agentsRunCommand } from './agentsRun';
import type { CliContext } from '../runtime/cliContext';

async function listAgents(context: CliContext): Promise<number> {
  await initLocalCliPlatform(context);
  await loadAgents({ includeRemote: false });
  const agents = [AgentCategory.Workflow, AgentCategory.ToolUse].flatMap(
    (category) =>
      getVisibleAgents(category).map((agent) => ({ ...agent, category })),
  );

  emitCliResult(
    context,
    {
      json: agents,
      ndjson: agents.map((agent) => ({ kind: 'agent', agent })),
      text: agents
        .map(
          (agent) =>
            `${agent.category}\t${agent.name}\t${agent.description ?? ''}`,
        )
        .join('\n'),
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

async function showAgent(context: CliContext, name: string): Promise<number> {
  await initLocalCliPlatform(context);
  await loadAgents({ includeRemote: false });

  const entry = getAgent(name);
  if (!entry) {
    writeTextStderr(`Agent not found: ${name}`);
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
  },
  run: (context) => listAgents(context),
});

const agentsShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one agent' },
  args: {
    ...GLOBAL_ARGS,
    name: {
      type: 'positional',
      required: true,
      description:
        'Agent name from `texra agents list` (use `source:name` to disambiguate when the same name exists in multiple sources)',
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
