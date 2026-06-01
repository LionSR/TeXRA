import { defineCommand } from 'citty';

import { getToolUseAgents, getWorkflowAgents, loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { CliUsageError } from '../runtime/cliContext';
import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform, initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  cliMultiAgentPlanHasGaps,
  cliMultiAgentPresetNdjsonRecords,
  findCliMultiAgentPreset,
  formatCliMultiAgentPresetDetails,
  formatCliMultiAgentPresetList,
  planCliMultiAgentPresetRun,
  readCliMultiAgentPresets,
  withCliMultiAgentPresetVisibility,
  type CliMultiAgentPresetRunPlan,
} from '../runtime/multiAgentPresets';
import { getCliAuthProvider } from '../runtime/supabaseAuth';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from './_helpers/modelArg';
import { formatMultiAgentRunInstruction } from './_helpers/multiAgentInstruction';
import { emitCliResult } from './_helpers/output';
import {
  GLOBAL_ARGS,
  collectStringFlagValues,
  optString,
} from './_helpers/globalArgs';
import { executeCliRequest } from './_helpers/runExecution';
import {
  createCliRunResult,
  terminalStatusExitCode,
  toolUseResultText,
  type CliRunResult,
} from './_helpers/terminalStatus';
import { expandRunInputs } from './_helpers/workflowInputs';
import type { CliContext } from '../runtime/cliContext';

type CliToolUseRunResult = Extract<CliRunResult, { category: 'toolUse' }>;

interface MultiAgentRunInit {
  readonly preset: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly agent?: string;
  readonly model?: string;
  readonly instruction: string;
}

function resolveMultiAgentRunPlan(
  init: Pick<MultiAgentRunInit, 'preset' | 'agent'>,
): CliMultiAgentPresetRunPlan {
  const preset = findCliMultiAgentPreset(
    readCliMultiAgentPresets(),
    init.preset,
  );
  if (!preset) {
    throw new CliUsageError(`Multi-agent preset not found: ${init.preset}`);
  }
  return planCliMultiAgentPresetRun(preset, {
    workflowAgents: getWorkflowAgents(),
    toolUseAgents: getToolUseAgents(),
    agentOverride: init.agent,
  });
}

/**
 * Resolve a preset plan, then — when it still has gaps and the user is
 * authenticated — perform a remote load and replan. Relay-served premium agents
 * (the team orchestrator and delegation specialists most presets name) are only
 * visible after a remote load, so a local-only resolve silently degrades the
 * team (e.g. falling back to the first plain tool-use agent as root). Both the
 * headless `multi-agent run` path and the interactive `orchestrate` menu route
 * through here so they can't drift apart again.
 *
 * Assumes local agents are already loaded by the caller.
 */
export async function fillMultiAgentRunPlanGaps(
  init: Pick<MultiAgentRunInit, 'preset' | 'agent'>,
): Promise<CliMultiAgentPresetRunPlan> {
  let plan = resolveMultiAgentRunPlan(init);
  if (
    cliMultiAgentPlanHasGaps(plan) &&
    (await getCliAuthProvider().isAuthenticated())
  ) {
    await loadAgents();
    plan = resolveMultiAgentRunPlan(init);
  }
  return plan;
}

export function writeMissingPresetAgents(
  plan: CliMultiAgentPresetRunPlan,
): void {
  const missing = [
    ...plan.missingWorkflowAgents.map((agent) => `workflow:${agent}`),
    ...plan.missingToolUseAgents.map((agent) => `tool-use:${agent}`),
  ];
  if (missing.length === 0) return;
  writeTextStderr(
    `WARN preset ${plan.preset.id} references unavailable agents: ${missing.join(', ')}`,
  );
}

function writeMultiAgentRunResult(
  context: CliContext,
  plan: CliMultiAgentPresetRunPlan,
  result: CliToolUseRunResult,
): void {
  const payload = {
    preset: {
      id: plan.preset.id,
      name: plan.preset.name,
      source: plan.preset.source,
    },
    rootAgent: plan.rootAgent?.name,
    result,
  };

  emitCliResult(context, {
    json: payload,
    ndjson: { kind: 'multi-agent-result', ...payload },
    text: toolUseResultText(result),
  });
}

async function runMultiAgentList(context: CliContext): Promise<number> {
  await initLocalCliPlatform(context);
  const presets = readCliMultiAgentPresets();

  emitCliResult(context, {
    json: presets,
    ndjson: cliMultiAgentPresetNdjsonRecords(presets),
    text: formatCliMultiAgentPresetList(presets),
  });
  return CliExitCode.Success;
}

async function runMultiAgentShow(
  context: CliContext,
  presetIdOrName: string,
): Promise<number> {
  await initLocalCliPlatform(context);
  const presets = readCliMultiAgentPresets();
  const preset = findCliMultiAgentPreset(presets, presetIdOrName);
  if (!preset) {
    writeTextStderr(`Multi-agent preset not found: ${presetIdOrName}`);
    return CliExitCode.Usage;
  }

  emitCliResult(context, {
    json: preset,
    ndjson: { kind: 'multi-agent-preset', preset },
    text: formatCliMultiAgentPresetDetails(preset),
  });
  return CliExitCode.Success;
}

export async function runMultiAgentPreset(
  context: CliContext,
  init: MultiAgentRunInit,
): Promise<number> {
  const hasInlineInstruction = init.instruction.trim().length > 0;
  if (init.inputFiles.length === 0 && !hasInlineInstruction) {
    throw new CliUsageError('Provide --input or --instruction.');
  }
  const { inputFiles, contextFiles } = await expandRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    { allowEmptyInput: hasInlineInstruction },
  );

  await initCliPlatform({ ...context, quietLogs: true });
  await loadAgents({ includeRemote: false });

  const plan = await fillMultiAgentRunPlanGaps(init);
  if (plan.missingAgentOverride) {
    throw new CliUsageError(
      `Tool-use agent not found: ${plan.missingAgentOverride}. Use \`texra agents list\` to see available agents.`,
    );
  }
  if (!plan.rootAgent) {
    writeTextStderr(
      `Multi-agent preset "${init.preset}" has no available tool-use agent to run. Use --agent with an installed tool-use agent, or enable a team with an orchestrator.`,
    );
    return CliExitCode.Usage;
  }
  writeMissingPresetAgents(plan);

  // A team run drives a tool-use orchestrator, so it follows the `chat`
  // (tool-use) model config rather than `run` (workflow agents). Resolve the
  // model after agent validation so usage errors stay focused on bad agents.
  const model = await resolveCliRunModel(context, init.model, 'chat');
  const runContext = buildHeadlessRunContext(context, model);
  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);

  const config: AgentConfigPayload = {
    agent: plan.rootAgent.name,
    model,
    inputFiles,
    contextFiles,
    instruction: formatMultiAgentRunInstruction(plan.preset, {
      inputFiles,
      instruction: init.instruction,
      approvalContext: runContext,
    }),
    workingDirectory: runContext.cwd,
    agentCategory: AgentCategory.ToolUse,
    cliMultiAgentPresetId: plan.preset.id,
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
      wrap: (run) => withCliMultiAgentPresetVisibility(plan, run),
    },
  );
  if (result.category !== AgentCategory.ToolUse) {
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    writeTextStderr(
      `Multi-agent preset "${init.preset}" resolved to a non tool-use execution.`,
    );
    return CliExitCode.AgentError;
  }
  const displayResult: CliToolUseRunResult = createCliRunResult(
    result,
    terminalStatus,
  );
  writeMultiAgentRunResult(runContext, plan, displayResult);

  return terminalStatusExitCode(terminalStatus, runContext);
}

const multiAgentListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List multi-agent team presets' },
  args: {
    ...GLOBAL_ARGS,
  },
  run: (context) => runMultiAgentList(context),
});

const multiAgentPresetArgs = {
  ...GLOBAL_ARGS,
  preset: {
    type: 'positional',
    required: true,
    description: 'Preset id or name from `texra multi-agent list`',
  },
} as const;

const multiAgentShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one multi-agent team preset' },
  args: multiAgentPresetArgs,
  run: (context, ctx) => runMultiAgentShow(context, ctx.args.preset),
});

const multiAgentInspectCommand = defineCliCommand({
  meta: { name: 'inspect', description: 'Inspect one multi-agent team preset' },
  args: multiAgentPresetArgs,
  run: (context, ctx) => runMultiAgentShow(context, ctx.args.preset),
});

const multiAgentRunCommand = defineCliCommand({
  meta: { name: 'run', description: 'Run a multi-agent team preset' },
  args: {
    ...GLOBAL_ARGS,
    preset: {
      type: 'positional',
      required: true,
      description: 'Preset id or name from `texra multi-agent list`',
    },
    input: {
      type: 'string',
      alias: 'i',
      description:
        'Input file passed to the team orchestrator (repeatable; optional when --instruction is provided; use `-` to read stdin)',
    },
    context: {
      type: 'string',
      alias: 'c',
      description:
        'Read-only context file passed to the team orchestrator (repeatable)',
    },
    agent: {
      type: 'string',
      description:
        'Tool-use agent to start as the team root (defaults to the preset orchestrator)',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Model for the root tool-use agent',
    },
    instruction: {
      type: 'string',
      description: 'Additional instruction for the team orchestrator',
    },
  },
  run: (context, ctx) =>
    runMultiAgentPreset(context, {
      preset: ctx.args.preset,
      inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
      contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
      agent: optString(ctx.args.agent),
      model: optString(ctx.args.model),
      instruction: optString(ctx.args.instruction) ?? '',
    }),
});

export const multiAgentCommand = defineCommand({
  meta: {
    name: 'multi-agent',
    description: 'List, inspect, and run multi-agent team presets',
  },
  subCommands: {
    list: multiAgentListCommand,
    show: multiAgentShowCommand,
    inspect: multiAgentInspectCommand,
    run: multiAgentRunCommand,
  },
});
