import type { AgentConfigPayload } from '@agent/runtime';

import { AgentCategory } from '@shared/schemas';
import {
  CliUsageError,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import {
  buildHeadlessRunContext,
  selectCliRunModel,
} from '../runtime/runModel';
import {
  TOOL_USE_AGENT_NAME_DESCRIPTION,
  resolveCliLaunchAgent,
} from '../runtime/agents';
import { initLocalCliPlatform } from '../runtime/initPlatform';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  AGENT_RUN_GLOBAL_ARGS,
  collectCommonAgentRunFlags,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import { emitCliResult } from './_helpers/output';
import { executeCliToolUseConfig } from '../runtime/runExecution';
import { toolUseResultText } from '../runtime/terminalStatus';
import { formatToolUseAgentRunInstruction } from './_helpers/runInstructions';
import { withExpandedRunInputs } from '../runtime/workflowInputs';

interface ToolUseAgentRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

export async function runToolUseAgent(
  context: CliContext,
  init: ToolUseAgentRunInit,
): Promise<number> {
  const instruction = await resolveFileBackedInstruction(init, context.cwd);
  if (!instruction) {
    throw new CliUsageError('Provide --instruction or --instruction-file.');
  }

  await initLocalCliPlatform(context);
  await resolveCliLaunchAgent(init.agent, 'agentsRun');

  const model = await selectCliRunModel(context, init.model, 'chat');
  const runContext = buildHeadlessRunContext(context);

  return withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    runContext.cwd,
    {
      allowEmptyInput: true,
      requireWorkspaceFiles: true,
      readStdinText: readCliStdinText,
    },
    async ({ inputFiles, contextFiles, hasMaterializedStdinInput }) => {
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

      const execution = await executeCliToolUseConfig(config, runContext, {
        enforceCategory: true,
        registerExecution: true,
        stopAfterCycle: true,
        recoveryInputIsDurable: hasMaterializedStdinInput !== true,
        categoryMismatchMessage: `Agent "${init.agent}" resolved to a non tool-use run.`,
      });
      if (!execution.ok) return execution.exitCode;

      emitCliResult(runContext, {
        json: execution.result,
        ndjson: { kind: 'agent-result', result: execution.result },
        text: toolUseResultText(execution.result),
      });

      return execution.exitCode;
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
      ...collectCommonAgentRunFlags(ctx.rawArgs, ctx.args.instruction),
      model: optString(ctx.args.model),
    }),
});
