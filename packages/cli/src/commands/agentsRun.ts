import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

import {
  CliUsageError,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { writeErrorStderr, writeTextStderr } from '../runtime/logSinks';
import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from '../runtime/runModel';
import { initLocalCliPlatform } from '../runtime/initPlatform';

import {
  TOOL_USE_AGENT_NAME_DESCRIPTION,
  missingToolUseAgentMessage,
} from './_helpers/agentLookupText';
import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  AGENT_RUN_GLOBAL_ARGS,
  collectStringFlagValues,
  optionalStringFlagValue,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import { emitCliResult } from './_helpers/output';
import { resolveCliAgent } from '../runtime/agentResolution';
import { executeCliRequest } from '../runtime/runExecution';
import {
  createCliRunResult,
  terminalStatusExitCode,
  toolUseResultText,
  type CliToolUseRunResult,
} from '../runtime/terminalStatus';
import { formatToolUseAgentRunInstruction } from './_helpers/toolUseRunInstruction';
import {
  createStdinWorkflowInputMaterializer,
  expandRunInputs,
} from '../runtime/workflowInputs';

export interface ToolUseAgentRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

async function resolveToolUseInstruction(
  init: Pick<ToolUseAgentRunInit, 'instruction' | 'instructionFile'>,
  cwd: string,
): Promise<string> {
  const instruction = await resolveFileBackedInstruction(init, cwd);
  if (!instruction) {
    throw new CliUsageError('Provide --instruction or --instruction-file.');
  }
  return instruction;
}

/**
 * Run a thunk, mapping a `CliUsageError` to the `Usage` exit code (after writing
 * it to stderr) and re-throwing anything else. Returns the thunk's value on
 * success; callers branch on `typeof result === 'number'` for the exit code.
 */
async function withUsageExit<T>(
  thunk: () => Promise<T>,
): Promise<T | CliExitCode> {
  try {
    return await thunk();
  } catch (error: unknown) {
    if (!(error instanceof CliUsageError)) {
      throw error;
    }
    writeErrorStderr(error);
    return CliExitCode.Usage;
  }
}

export async function runToolUseAgent(
  context: CliContext,
  init: ToolUseAgentRunInit,
): Promise<number> {
  let inputFiles: string[];
  let contextFiles: string[];
  const instruction = await withUsageExit(() =>
    resolveToolUseInstruction(init, context.cwd),
  );
  if (typeof instruction === 'number') return instruction;

  await initLocalCliPlatform(context);
  const agent = await resolveCliAgent(init.agent);

  if (!agent) {
    writeTextStderr(missingToolUseAgentMessage(init.agent));
    return CliExitCode.Usage;
  }
  if (agent.category !== AgentCategory.ToolUse) {
    writeTextStderr(
      `Agent "${init.agent}" is a ${agent.category} agent; \`texra agents run\` only handles tool-use agents. Use \`texra run ${init.agent}\` for workflow agents.`,
    );
    return CliExitCode.Usage;
  }

  const model = await resolveCliRunModel(context, init.model, 'chat');
  const runContext = buildHeadlessRunContext(context, model);

  const stdinInputFile = createStdinWorkflowInputMaterializer({
    readStdinText: readCliStdinText,
    tempDir: runContext.cwd,
  });
  try {
    const expanded = await withUsageExit(() =>
      expandRunInputs(init.inputFiles, init.contextFiles, runContext.cwd, {
        allowEmptyInput: true,
        requireWorkspaceFiles: true,
        stdinInputFile,
      }),
    );
    if (typeof expanded === 'number') return expanded;
    inputFiles = expanded.inputFiles;
    contextFiles = expanded.contextFiles;

    const config: AgentConfigPayload = {
      agent: init.agent,
      model,
      inputFiles,
      contextFiles,
      instruction: formatToolUseAgentRunInstruction({
        inputFiles,
        contextFiles,
        instruction,
      }),
      displayInstruction: instruction,
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
      {
        workingDirectory: runContext.cwd,
      },
    );
    emitCliResult(runContext, {
      json: displayResult,
      ndjson: { kind: 'agent-result', result: displayResult },
      text: toolUseResultText(displayResult),
    });

    return terminalStatusExitCode(terminalStatus, runContext);
  } finally {
    await stdinInputFile.cleanup();
  }
}

export const agentsRunCommand = defineCliCommand({
  meta: { name: 'run', description: 'Run a tool-use agent headlessly' },
  args: {
    ...AGENT_RUN_GLOBAL_ARGS,
    name: {
      type: 'positional',
      required: true,
      description: TOOL_USE_AGENT_NAME_DESCRIPTION,
    },
    input: {
      type: 'string',
      alias: 'i',
      valueHint: 'file',
      description:
        'Workspace file made visible to the agent (repeatable; use `-` to read stdin)',
    },
    context: {
      type: 'string',
      alias: 'c',
      valueHint: 'file',
      description:
        'Read-only context file made visible to the agent (repeatable; use `-` to read stdin)',
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
      valueHint: 'file',
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
      instructionFile: optionalStringFlagValue(ctx.rawArgs, 'instruction-file'),
    }),
});
