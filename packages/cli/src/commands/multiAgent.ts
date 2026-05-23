import { defineCommand } from 'citty';

import { getToolUseAgents, getWorkflowAgents, loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';

import { runValidatedExecutionRequest } from '@agent/runtime/runExecutionRequest';
import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { CliUsageError } from '../runtime/cliContext';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  resolveConfiguredModel,
} from '../runtime/cliConfig';
import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import {
  cliMultiAgentPlanHasGaps,
  cliMultiAgentPresetNdjsonRecords,
  findCliMultiAgentPreset,
  formatCliMultiAgentPresetDetails,
  formatCliMultiAgentPresetList,
  planCliMultiAgentPresetRun,
  readCliMultiAgentPresets,
  withCliMultiAgentPresetVisibility,
  type CliMultiAgentPreset,
  type CliMultiAgentPresetRunPlan,
} from '../runtime/multiAgentPresets';
import { shouldRenderRunProgress } from '../runtime/runProgressRenderer';
import { createCliRuntimeHost } from '../runtime/runtimeHost';
import { getCliAuthProvider } from '../runtime/supabaseAuth';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import {
  GLOBAL_ARGS,
  collectStringFlagValues,
  optString,
} from './_helpers/globalArgs';
import {
  createCliRunResult,
  readCliTerminalStatus,
  terminalStatusExitCode,
  type CliRunResult,
  type ExecuteAgentResult,
} from './_helpers/terminalStatus';
import {
  expandWorkflowInputSpec,
  expandWorkflowInputSpecs,
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
}

export function resolveMultiAgentRunPlan(
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

function writeMissingPresetAgents(plan: CliMultiAgentPresetRunPlan): void {
  const missing = [
    ...plan.missingWorkflowAgents.map((agent) => `workflow:${agent}`),
    ...plan.missingToolUseAgents.map((agent) => `tool-use:${agent}`),
  ];
  if (missing.length === 0) return;
  writeTextStderr(
    `WARN preset ${plan.preset.id} references unavailable agents: ${missing.join(', ')}`,
  );
}

function formatMultiAgentRunInstruction(
  preset: CliMultiAgentPreset,
  init: Pick<MultiAgentRunInit, 'instruction'>,
): string {
  const parts = [
    `Run the "${preset.name}" multi-agent team preset.`,
    preset.description,
    'Use the visible workflow and tool-use agents as the team available for delegation.',
  ];
  const instruction = init.instruction.trim();
  if (instruction) {
    parts.push('Additional user instruction:', instruction);
  }
  return parts.join('\n\n');
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

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(payload, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'multi-agent-result',
      ts: new Date().toISOString(),
      ...payload,
    });
  } else {
    writeTextStdout(
      result.lastResponse?.trim() ||
        `${result.status}\nExecution: ${result.executionId}`,
    );
  }
}

async function runMultiAgentList(context: CliContext): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  const presets = readCliMultiAgentPresets();

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(presets, null, 2));
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    for (const record of cliMultiAgentPresetNdjsonRecords(presets)) {
      writeNdjsonStdout(record);
    }
    return CliExitCode.Success;
  }

  writeTextStdout(formatCliMultiAgentPresetList(presets));
  return CliExitCode.Success;
}

async function runMultiAgentShow(
  context: CliContext,
  presetIdOrName: string,
): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  const presets = readCliMultiAgentPresets();
  const preset = findCliMultiAgentPreset(presets, presetIdOrName);
  if (!preset) {
    writeTextStderr(`Multi-agent preset not found: ${presetIdOrName}`);
    return CliExitCode.Usage;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(preset, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'multi-agent-preset',
      ts: new Date().toISOString(),
      preset,
    });
  } else {
    writeTextStdout(formatCliMultiAgentPresetDetails(preset));
  }
  return CliExitCode.Success;
}

async function runMultiAgentPreset(
  context: CliContext,
  init: MultiAgentRunInit,
): Promise<number> {
  const model =
    init.model?.trim() ||
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
  const inputFiles = await expandWorkflowInputSpecs(
    init.inputFiles,
    runContext.cwd,
  );
  const contextFiles = (
    await Promise.all(
      init.contextFiles.map((spec) =>
        expandWorkflowInputSpec(spec, runContext.cwd, '--context'),
      ),
    )
  ).flat();

  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents({ includeRemote: false });

  let plan = resolveMultiAgentRunPlan(init);
  // Relay-served premium agents (the team orchestrator and delegation
  // specialists most presets name) are only visible after a remote load. Fill
  // any preset gap — not just a missing root — so an authenticated, entitled
  // user runs the full team instead of a silently degraded one.
  if (
    cliMultiAgentPlanHasGaps(plan) &&
    (await getCliAuthProvider().isAuthenticated())
  ) {
    await loadAgents();
    plan = resolveMultiAgentRunPlan(init);
  }
  if (!plan.rootAgent) {
    writeTextStderr(
      `Multi-agent preset "${init.preset}" has no available tool-use agent to run. Use --agent with an installed tool-use agent, or enable a team with an orchestrator.`,
    );
    return CliExitCode.Usage;
  }
  writeMissingPresetAgents(plan);

  const config: AgentConfigPayload = {
    agent: plan.rootAgent.name,
    model,
    inputFiles,
    contextFiles,
    instruction: formatMultiAgentRunInstruction(plan.preset, init),
    workingDirectory: runContext.cwd,
    agentCategory: AgentCategory.ToolUse,
    cliMultiAgentPresetId: plan.preset.id,
  };

  const executionId = generateExecutionId();
  const registeredConfig = AgentConfigSchema.parse(config);
  const runtimeHost = createCliRuntimeHost(runContext);
  let result: ExecuteAgentResult;
  try {
    result = await withCliMultiAgentPresetVisibility(plan, () =>
      runValidatedExecutionRequest(
        { config: registeredConfig, executionId },
        {
          runtimeHost,
          enforceCategory: true,
          registerExecution: true,
        },
      ),
    );
  } catch (error) {
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    throw error;
  } finally {
    await runtimeHost.close();
  }

  const terminalStatus = await readCliTerminalStatus(result);
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

const multiAgentListCommand = defineCommand({
  meta: { name: 'list', description: 'List multi-agent team presets' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runMultiAgentList(context));
  },
});

const multiAgentShowCommand = defineCommand({
  meta: { name: 'show', description: 'Show one multi-agent team preset' },
  args: {
    ...GLOBAL_ARGS,
    preset: {
      type: 'positional',
      required: true,
      description: 'Preset id or name from `texra multi-agent list`',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runMultiAgentShow(context, ctx.args.preset));
  },
});

const multiAgentRunCommand = defineCommand({
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
      required: true,
      description: 'Input file passed to the team orchestrator',
    },
    context: {
      type: 'string',
      alias: 'c',
      description: 'Read-only context file passed to the team orchestrator',
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
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(
      await runMultiAgentPreset(context, {
        preset: ctx.args.preset,
        inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
        contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
        agent: optString(ctx.args.agent),
        model: optString(ctx.args.model),
        instruction: optString(ctx.args.instruction) ?? '',
      }),
    );
  },
});

export const multiAgentCommand = defineCommand({
  meta: { name: 'multi-agent', description: 'Inspect multi-agent teams' },
  subCommands: {
    list: multiAgentListCommand,
    show: multiAgentShowCommand,
    run: multiAgentRunCommand,
  },
});
