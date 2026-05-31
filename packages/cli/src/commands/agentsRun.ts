import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliUsageError, type CliContext } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeErrorStderr, writeTextStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  GLOBAL_ARGS,
  collectStringFlagValues,
  optString,
} from './_helpers/globalArgs';
import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from './_helpers/modelArg';
import { emitCliResult } from './_helpers/output';
import { resolveAgentWithRemoteFallback } from './_helpers/remoteAgents';
import { executeCliRequest } from './_helpers/runExecution';
import {
  createCliRunResult,
  terminalStatusExitCode,
  toolUseResultText,
  type CliRunResult,
} from './_helpers/terminalStatus';
import { expandWorkflowInputSpecs } from './_helpers/workflowInputs';

type CliToolUseRunResult = Extract<CliRunResult, { category: 'toolUse' }>;

interface ToolUseAgentRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
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
    text: toolUseResultText(result),
  });
}

async function runToolUseAgent(
  context: CliContext,
  init: ToolUseAgentRunInit,
): Promise<number> {
  const model = await resolveCliRunModel(context, init.model, 'chat');
  const runContext = buildHeadlessRunContext(context, model);

  let inputFiles: string[];
  let contextFiles: string[];
  let instruction: string;
  try {
    [inputFiles, contextFiles, instruction] = await Promise.all([
      expandWorkflowInputSpecs(init.inputFiles, runContext.cwd, '--input', {
        allowEmpty: true,
      }),
      expandWorkflowInputSpecs(init.contextFiles, runContext.cwd, '--context', {
        allowEmpty: true,
      }),
      resolveToolUseInstruction(init, runContext.cwd),
    ]);
  } catch (error: unknown) {
    if (!(error instanceof CliUsageError)) {
      throw error;
    }
    writeErrorStderr(error);
    return CliExitCode.Usage;
  }

  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents({ includeRemote: false });
  const agent = await resolveAgentWithRemoteFallback(init.agent);

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

export const agentsRunCommand = defineCliCommand({
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
      description:
        'File whose contents are passed before --instruction when both are set',
    },
  },
  run: (context, ctx) =>
    runToolUseAgent(context, {
      agent: ctx.args.name,
      inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
      contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
      model: optString(ctx.args.model),
      instruction: optString(ctx.args.instruction) ?? '',
      instructionFile: optString(ctx.args['instruction-file']),
    }),
});
