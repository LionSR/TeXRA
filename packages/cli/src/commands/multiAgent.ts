import { defineCommand } from 'citty';

import { getToolUseAgents, getWorkflowAgents, loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { EXECUTION_STATUS } from '@shared/schemas';
import { agentKey } from '@shared/schemas/agent';
import { generateExecutionId } from '@utils/core/executionId';
import { CliUsageError, readCliStdinText } from '../runtime/cliContext';
import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform, initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  agentHasDelegationTools,
  cliMultiAgentPlanHasGaps,
  cliMultiAgentPresetTeamLaunchBlockReason,
  cliMultiAgentPresetNdjsonRecords,
  cliMultiAgentPresetListRecords,
  findCliMultiAgentPreset,
  formatCliMultiAgentPresetDetails,
  formatCliMultiAgentPresetInspection,
  formatCliMultiAgentPresetList,
  planCliMultiAgentPresets,
  planCliMultiAgentPresetRun,
  readCliMultiAgentPresets,
  withCliMultiAgentPresetVisibility,
  MULTI_AGENT_TEAM_ROOT_AGENT_DESCRIPTION,
  MULTI_AGENT_TEAM_ROOT_MODEL_DESCRIPTION,
  type CliMultiAgentPreset,
  type CliMultiAgentPresetRunPlan,
} from '../runtime/multiAgentPresets';
import { getCliAuthProvider } from '../runtime/supabaseAuth';

import { missingToolUseAgentMessage } from './_helpers/agentLookupText';
import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from './_helpers/modelArg';
import { formatMultiAgentRunInstruction } from './_helpers/multiAgentInstruction';
import { emitCliResult } from './_helpers/output';
import {
  AGENT_RUN_GLOBAL_ARGS,
  GLOBAL_ARGS,
  collectStringFlagValues,
  optionalStringFlagValue,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import { executeCliRequest } from './_helpers/runExecution';
import {
  createCliRunResult,
  terminalStatusExitCode,
  toolUseResultText,
  type CliRunResult,
} from './_helpers/terminalStatus';
import { approvalPromptsUnavailable } from './_helpers/approvalPolicyInstruction';
import {
  createStdinWorkflowInputMaterializer,
  expandRunInputs,
} from './_helpers/workflowInputs';
import type { CliContext } from '../runtime/cliContext';

type CliToolUseRunResult = Extract<CliRunResult, { category: 'toolUse' }>;

interface MultiAgentRunInit {
  readonly preset: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly agent?: string;
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

interface RemoteAgentPlanReloadResult<T> {
  readonly value: T;
  readonly remoteAgentLoadAttempted: boolean;
}

export interface MultiAgentRunPlanLoadResult {
  readonly plan: CliMultiAgentPresetRunPlan;
  readonly remoteAgentLoadAttempted: boolean;
}

export interface MultiAgentPresetPlansLoadResult {
  readonly plans: readonly CliMultiAgentPresetRunPlan[];
  readonly remoteAgentLoadAttempted: boolean;
}

const MULTI_AGENT_TASK_REQUIRED_MESSAGE =
  'Provide --input, --instruction, or --instruction-file for the team task. Example: texra multi-agent run physicist --instruction "Check this derivation"';

function planCurrentMultiAgentRun(
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

function planLoadedCliMultiAgentPresets(
  presets: readonly CliMultiAgentPreset[],
): CliMultiAgentPresetRunPlan[] {
  return planCliMultiAgentPresets(presets, {
    workflowAgents: getWorkflowAgents(),
    toolUseAgents: getToolUseAgents(),
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
  return (await loadCliMultiAgentRunPlan(init)).plan;
}

export async function loadCliMultiAgentRunPlan(
  init: Pick<MultiAgentRunInit, 'preset' | 'agent'>,
): Promise<MultiAgentRunPlanLoadResult> {
  const result = await reloadRemoteAgentsForGaps(
    planCurrentMultiAgentRun(init),
    cliMultiAgentPlanHasGaps,
    () => planCurrentMultiAgentRun(init),
  );
  return {
    plan: result.value,
    remoteAgentLoadAttempted: result.remoteAgentLoadAttempted,
  };
}

export async function loadCliMultiAgentPresetPlanSet(
  presets: readonly CliMultiAgentPreset[],
): Promise<MultiAgentPresetPlansLoadResult> {
  await loadAgents({ includeRemote: false });
  const result = await reloadRemoteAgentsForGaps(
    planLoadedCliMultiAgentPresets(presets),
    (plans) => plans.some(cliMultiAgentPlanHasGaps),
    () => planLoadedCliMultiAgentPresets(presets),
  );
  return {
    plans: result.value,
    remoteAgentLoadAttempted: result.remoteAgentLoadAttempted,
  };
}

export async function loadCliMultiAgentPresetPlans(
  presets: readonly CliMultiAgentPreset[],
): Promise<readonly CliMultiAgentPresetRunPlan[]> {
  return (await loadCliMultiAgentPresetPlanSet(presets)).plans;
}

async function reloadRemoteAgentsForGaps<T>(
  value: T,
  hasGaps: (value: T) => boolean,
  replan: () => T,
): Promise<RemoteAgentPlanReloadResult<T>> {
  if (hasGaps(value) && (await getCliAuthProvider().isAuthenticated())) {
    await loadAgents();
    return { value: replan(), remoteAgentLoadAttempted: true };
  }
  return { value, remoteAgentLoadAttempted: false };
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
  if (!plan.rootAgent) return;

  const availableTeamAgents = new Set([
    ...plan.workflowAgentKeys,
    ...plan.toolUseAgentKeys,
  ]);
  availableTeamAgents.delete(
    agentKey(plan.rootAgent.source, plan.rootAgent.name),
  );
  if (!agentHasDelegationTools(plan.rootAgent)) return;
  if (availableTeamAgents.size === 0) return;

  const availableText =
    availableTeamAgents.size === 1
      ? '1 available team agent'
      : `${availableTeamAgents.size} available team agents`;
  writeTextStderr(
    `WARN preset ${plan.preset.id} is degraded; running root agent ${plan.rootAgent.name} with ${availableText}.`,
  );
}

function writeApprovalUnavailableDelegationWarning(
  context: CliContext,
  plan: CliMultiAgentPresetRunPlan,
): void {
  if (
    !plan.rootAgent ||
    !agentHasDelegationTools(plan.rootAgent) ||
    !approvalPromptsUnavailable(context)
  ) {
    return;
  }

  const reason =
    context.approvalPolicy === 'never'
      ? 'approval policy "never" denies approval-gated delegation tools'
      : 'headless approval policy "ask" cannot show delegation prompts';
  writeTextStderr(
    `WARN preset ${plan.preset.id} may run without subagent delegation because ${reason}. Use an interactive run to answer prompts, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.`,
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
  const { plans, remoteAgentLoadAttempted } =
    await loadCliMultiAgentPresetPlanSet(presets);
  const records = cliMultiAgentPresetListRecords(plans);

  emitCliResult(context, {
    json: records,
    ndjson: cliMultiAgentPresetNdjsonRecords(plans),
    text: formatCliMultiAgentPresetList(plans, {
      includeLoginHint: !remoteAgentLoadAttempted,
    }),
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

async function runMultiAgentInspect(
  context: CliContext,
  presetIdOrName: string,
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  await loadAgents({ includeRemote: false });

  const { plan, remoteAgentLoadAttempted } = await loadCliMultiAgentRunPlan({
    preset: presetIdOrName,
  });

  emitCliResult(context, {
    json: plan,
    ndjson: { kind: 'multi-agent-preset-inspection', plan },
    text: formatCliMultiAgentPresetInspection(plan, {
      includeLoginHint: !remoteAgentLoadAttempted,
    }),
  });
  return CliExitCode.Success;
}

export async function runMultiAgentPreset(
  context: CliContext,
  init: MultiAgentRunInit,
): Promise<number> {
  const instruction = await resolveFileBackedInstruction(init, context.cwd);
  const hasInstruction = instruction.trim().length > 0;
  if (init.inputFiles.length === 0 && !hasInstruction) {
    throw new CliUsageError(MULTI_AGENT_TASK_REQUIRED_MESSAGE);
  }

  await initCliPlatform({ ...context, quietLogs: true });
  await loadAgents({ includeRemote: false });

  const plan = await fillMultiAgentRunPlanGaps(init);
  if (plan.missingAgentOverride) {
    throw new CliUsageError(
      missingToolUseAgentMessage(plan.missingAgentOverride),
    );
  }
  const rootAgent = plan.rootAgent;
  const teamLaunchBlockReason = cliMultiAgentPresetTeamLaunchBlockReason(plan);
  if (teamLaunchBlockReason || !rootAgent) {
    const singleAgentAdvice = rootAgent
      ? `Start a single-agent chat with \`texra chat --agent ${rootAgent.name}\` if that is what you want.`
      : 'Install or sign in for a runnable team root before launching this preset.';
    writeTextStderr(
      `Multi-agent preset "${init.preset}" cannot start as a team: ${teamLaunchBlockReason ?? 'no runnable team root'}. Run \`texra multi-agent inspect ${plan.preset.id}\` to see missing agents. ${singleAgentAdvice}`,
    );
    return CliExitCode.Usage;
  }
  writeMissingPresetAgents(plan);

  // A team run drives a tool-use orchestrator, so it follows the `chat`
  // (tool-use) model config rather than `run` (workflow agents). Resolve the
  // model after agent validation so usage errors stay focused on bad agents.
  const model = await resolveCliRunModel(context, init.model, 'chat');
  const runContext = buildHeadlessRunContext(context, model);
  const stdinInputFile = createStdinWorkflowInputMaterializer({
    readStdinText: readCliStdinText,
    tempDir: runContext.cwd,
  });
  try {
    const { inputFiles, contextFiles } = await expandRunInputs(
      init.inputFiles,
      init.contextFiles,
      runContext.cwd,
      {
        allowEmptyInput: hasInstruction,
        requireWorkspaceFiles: true,
        stdinInputFile,
      },
    );
    installCliApprovalHandlers(runContext);
    writeApprovalUnavailableDelegationWarning(runContext, plan);

    const config: AgentConfigPayload = {
      agent: rootAgent.name,
      model,
      inputFiles,
      contextFiles,
      instruction: formatMultiAgentRunInstruction(plan.preset, {
        inputFiles,
        contextFiles,
        instruction,
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
      {
        workingDirectory: runContext.cwd,
      },
    );
    writeMultiAgentRunResult(runContext, plan, displayResult);

    return terminalStatusExitCode(terminalStatus, runContext);
  } finally {
    await stdinInputFile.cleanup();
  }
}

const multiAgentListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List multi-agent team presets' },
  args: {
    ...GLOBAL_ARGS,
  },
  run: runMultiAgentList,
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
  run: (context, ctx) => runMultiAgentInspect(context, ctx.args.preset),
});

const multiAgentRunCommand = defineCliCommand({
  meta: { name: 'run', description: 'Run a multi-agent team preset' },
  args: {
    ...AGENT_RUN_GLOBAL_ARGS,
    preset: {
      type: 'positional',
      required: true,
      description: 'Preset id or name from `texra multi-agent list`',
    },
    input: {
      type: 'string',
      alias: 'i',
      valueHint: 'file',
      description:
        'Input file passed to the team orchestrator (repeatable; optional when --instruction or --instruction-file is provided; use `-` to read stdin)',
    },
    context: {
      type: 'string',
      alias: 'c',
      valueHint: 'file',
      description:
        'Read-only context file passed to the team orchestrator (repeatable; use `-` to read stdin)',
    },
    agent: {
      type: 'string',
      description: MULTI_AGENT_TEAM_ROOT_AGENT_DESCRIPTION,
    },
    model: {
      type: 'string',
      alias: 'm',
      description: MULTI_AGENT_TEAM_ROOT_MODEL_DESCRIPTION,
    },
    instruction: {
      type: 'string',
      description: 'Additional instruction for the team orchestrator',
    },
    'instruction-file': {
      type: 'string',
      valueHint: 'file',
      description:
        'File whose contents are passed before --instruction when both are set',
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
      instructionFile: optionalStringFlagValue(ctx.rawArgs, 'instruction-file'),
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
