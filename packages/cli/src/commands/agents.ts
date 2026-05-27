import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { defineCommand } from 'citty';

import { getAgent, getVisibleAgents, loadAgents } from '@agent/index';
import type { AgentEntry } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { toErrorMessage } from '@common/errors/errorMessage';
import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliUsageError } from '../runtime/cliContext';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  resolveConfiguredModel,
} from '../runtime/cliConfig';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform, initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';
import { shouldRenderRunProgress } from '../runtime/runProgressRenderer';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { assertExplicitModelKnown } from './_helpers/modelArg';
import {
  GLOBAL_ARGS,
  collectStringFlagValues,
  optString,
} from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { shouldHonorRemoteAgentPriority } from './_helpers/remoteAgents';
import { executeCliRequest } from './_helpers/runExecution';
import {
  createCliRunResult,
  terminalStatusExitCode,
  type CliRunResult,
} from './_helpers/terminalStatus';
import { expandWorkflowInputSpec } from './_helpers/workflowInputs';
import type { CliContext } from '../runtime/cliContext';

type CliToolUseRunResult = Extract<CliRunResult, { category: 'toolUse' }>;

interface ToolUseAgentRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

async function listAgents(context: CliContext): Promise<number> {
  await initLocalCliPlatform(context);
  await loadAgents({ includeRemote: false });
  const agents = [AgentCategory.Workflow, AgentCategory.ToolUse].flatMap(
    (category) =>
      getVisibleAgents(category).map((agent) => ({ ...agent, category })),
  );

  emitCliResult(context, {
    json: agents,
    ndjson: agents.map((agent) => ({ kind: 'agent', agent })),
    text: agents
      .map(
        (agent) =>
          `${agent.category}\t${agent.name}\t${agent.description ?? ''}`,
      )
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

async function expandOptionalInputSpecs(
  specs: readonly string[],
  cwd: string,
  flagLabel: string,
): Promise<string[]> {
  const expanded = (
    await Promise.all(
      specs.map((spec) => expandWorkflowInputSpec(spec, cwd, flagLabel)),
    )
  ).flat();
  return [...new Set(expanded)];
}

async function readInstructionFile(
  instructionFile: string | undefined,
  cwd: string,
): Promise<string> {
  const trimmed = instructionFile?.trim();
  if (!trimmed) return '';
  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(cwd, trimmed);
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error: unknown) {
    if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
      throw new CliUsageError(`--instruction-file: file not found: ${trimmed}`);
    }
    throw error;
  }
}

async function resolveToolUseInstruction(
  init: Pick<ToolUseAgentRunInit, 'instruction' | 'instructionFile'>,
  cwd: string,
): Promise<string> {
  const fileInstruction = await readInstructionFile(init.instructionFile, cwd);
  const inlineInstruction = init.instruction.trim();
  const instruction = [fileInstruction.trim(), inlineInstruction]
    .filter(Boolean)
    .join('\n\n');
  if (!instruction) {
    throw new CliUsageError('Provide --instruction or --instruction-file.');
  }
  return instruction;
}

function writeToolUseRunResult(
  context: CliContext,
  result: CliToolUseRunResult,
): void {
  emitCliResult(context, {
    json: result,
    ndjson: { kind: 'agent-result', result },
    text:
      result.lastResponse?.trim() ||
      `${result.status}\nExecution: ${result.executionId}`,
  });
}

async function runToolUseAgent(
  context: CliContext,
  init: ToolUseAgentRunInit,
): Promise<number> {
  const explicitModel = assertExplicitModelKnown(init.model);
  const model =
    explicitModel ||
    context.envModel ||
    resolveConfiguredModel(context.cliConfig, 'chat') ||
    CLI_BUILTIN_DEFAULT_MODEL;
  const renderRunProgress = shouldRenderRunProgress(context);
  const runContext: CliContext = {
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress,
  };

  let inputFiles: string[];
  let contextFiles: string[];
  let instruction: string;
  try {
    [inputFiles, contextFiles, instruction] = await Promise.all([
      expandOptionalInputSpecs(init.inputFiles, runContext.cwd, '--input'),
      expandOptionalInputSpecs(init.contextFiles, runContext.cwd, '--context'),
      resolveToolUseInstruction(init, runContext.cwd),
    ]);
  } catch (error: unknown) {
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.Usage;
  }

  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents({ includeRemote: false });
  let agent = getAgent(init.agent);
  if (!agent || (await shouldHonorRemoteAgentPriority(init.agent))) {
    await loadAgents();
    agent = getAgent(init.agent);
  }

  if (!agent) {
    writeTextStderr(
      `Agent not found: ${init.agent}. Use \`texra agents list\` to see available agents.`,
    );
    return CliExitCode.Usage;
  }
  if (agent.category !== AgentCategory.ToolUse) {
    writeTextStderr(
      `Agent "${init.agent}" is a ${agent.category} agent; \`texra agents run\` only handles tool-use agents. Use \`texra run ${init.agent}\` for workflow agents.`,
    );
    return CliExitCode.Usage;
  }

  const config: AgentConfigPayload = {
    agent: init.agent,
    model,
    inputFiles,
    contextFiles,
    instruction,
    workingDirectory: runContext.cwd,
    agentCategory: AgentCategory.ToolUse,
  };

  const executionId = generateExecutionId();
  const registeredConfig = AgentConfigSchema.parse(config);
  const { result, terminalStatus } = await executeCliRequest(
    { config: registeredConfig, executionId },
    runContext,
    {
      enforceCategory: true,
      registerExecution: true,
      markErrorOnThrow: true,
      stopAfterCycle: true,
    },
  );
  if (result.category !== AgentCategory.ToolUse) {
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    writeTextStderr(`Agent "${init.agent}" resolved to a non tool-use run.`);
    return CliExitCode.AgentError;
  }

  const displayResult: CliToolUseRunResult = createCliRunResult(
    result,
    terminalStatus,
  );
  writeToolUseRunResult(runContext, displayResult);

  return terminalStatusExitCode(terminalStatus, runContext);
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

const agentsRunCommand = defineCommand({
  meta: { name: 'run', description: 'Run a tool-use agent headlessly' },
  args: {
    ...GLOBAL_ARGS,
    name: {
      type: 'positional',
      required: true,
      description: 'Tool-use agent name from `texra agents list`',
    },
    input: {
      type: 'string',
      alias: 'i',
      description: 'Workspace file made visible to the agent (repeatable)',
    },
    context: {
      type: 'string',
      alias: 'c',
      description:
        'Read-only context file made visible to the agent (repeatable)',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Model for the agent',
    },
    instruction: {
      type: 'string',
      description: 'Instruction passed to the agent',
    },
    'instruction-file': {
      type: 'string',
      description: 'File whose contents are passed as the agent instruction',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(
      await runToolUseAgent(context, {
        agent: ctx.args.name,
        inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
        contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
        model: optString(ctx.args.model),
        instruction: optString(ctx.args.instruction) ?? '',
        instructionFile: optString(ctx.args['instruction-file']),
      }),
    );
  },
});

export const agentsCommand = defineCommand({
  meta: { name: 'agents', description: 'Inspect TeXRA agents' },
  subCommands: {
    list: agentsListCommand,
    show: agentsShowCommand,
    run: agentsRunCommand,
  },
});
