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
import { writeTextStderr } from '../runtime/logSinks';
import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from '../runtime/runModel';
import {
  TOOL_USE_AGENT_NAME_DESCRIPTION,
  assertCliAgentLaunch,
  resolveCliAgent,
} from '../runtime/agents';
import { initLocalCliPlatform } from '../runtime/initPlatform';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  AGENT_RUN_GLOBAL_ARGS,
  collectStringFlagValues,
  optionalStringFlagValue,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import { emitCliResult } from './_helpers/output';
import { executeCliRequest } from '../runtime/runExecution';
import {
  createCliRunResult,
  terminalStatusExitCode,
  toolUseResultText,
  type CliToolUseRunResult,
} from '../runtime/terminalStatus';
import { formatToolUseAgentRunInstruction } from './_helpers/toolUseRunInstruction';
import { withExpandedRunInputs } from '../runtime/workflowInputs';

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

export async function runToolUseAgent(
  context: CliContext,
  init: ToolUseAgentRunInit,
): Promise<number> {
  const instruction = await resolveToolUseInstruction(init, context.cwd);

  await initLocalCliPlatform(context);
  assertCliAgentLaunch(
    init.agent,
    await resolveCliAgent(init.agent, AgentCategory.ToolUse),
    'agentsRun',
  );

  const model = await resolveCliRunModel(context, init.model, 'chat');
  const runContext = buildHeadlessRunContext(context, model);

  return withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    runContext.cwd,
    {
      allowEmptyInput: true,
      requireWorkspaceFiles: true,
      readStdinText: readCliStdinText,
    },
    async ({ inputFiles, contextFiles }) => {
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
        writeTextStderr(
          `Agent "${init.agent}" resolved to a non tool-use run.`,
        );
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
    },
  );
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
