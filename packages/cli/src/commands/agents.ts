import { defineCommand } from 'citty';

import { getAgent, getVisibleAgents, loadAgents } from '@agent/index';
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';

import { CliExitCode } from '../runtime/exitCodes';
import { initReadonlyCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

async function listAgents(context: CliContext): Promise<number> {
  await initReadonlyCliPlatform(context);
  await loadAgents({ includeRemote: false });
  const agents = [AgentCategory.Workflow, AgentCategory.ToolUse].flatMap(
    (category) =>
      getVisibleAgents(category).map((agent) => ({ ...agent, category })),
  );

  emitCliResult(context, {
    json: agents,
    ndjson: agents.map((agent) => ({ kind: 'agent', agent })),
    text: agents
      .map((agent) => `${agent.category}\t${agent.name}\t${agent.description ?? ''}`)
      .join('\n'),
  });
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
  await initReadonlyCliPlatform(context);
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

const agentsListCommand = defineCommand({
  meta: { name: 'list', description: 'List available agents' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await listAgents(context));
  },
});

const agentsShowCommand = defineCommand({
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
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await showAgent(context, ctx.args.name));
  },
});

export const agentsCommand = defineCommand({
  meta: { name: 'agents', description: 'Inspect TeXRA agents' },
  subCommands: {
    list: agentsListCommand,
    show: agentsShowCommand,
  },
});
