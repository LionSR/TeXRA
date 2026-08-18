import { defineCommand } from 'citty';

import type { AgentConfigPayload } from '@agent/runtime';
import { canLaunchTeam, teamPlanHasGaps } from '@common/teams/TeamPlan';
import { byCategory, AgentCategory } from '@shared/schemas';
import { filterNotNullish } from '@utils/core';

import { missingToolUseAgentMessage } from '../runtime/agents';
import {
  CliUsageError,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform, initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  cliMultiAgentPresetNdjsonRecords,
  cliMultiAgentPresetListRecords,
  formatCliMultiAgentTeamLaunchBlockMessage,
  formatCliMultiAgentPresetInspection,
  formatCliMultiAgentPresetList,
  readCliMultiAgentPresets,
  MULTI_AGENT_TEAM_ROOT_AGENT_DESCRIPTION,
  MULTI_AGENT_TEAM_ROOT_MODEL_DESCRIPTION,
  type CliMultiAgentPresetRunPlan,
} from '../runtime/multiAgentPresets';
import {
  loadCliMultiAgentPresetPlanSet,
  loadCliMultiAgentRunPlan,
  writeMissingPresetAgents,
} from '../runtime/multiAgentRunPlan';
import {
  buildHeadlessRunContext,
  selectCliRunModel,
} from '../runtime/runModel';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { formatMultiAgentRunInstruction } from './_helpers/runInstructions';
import { emitCliResult } from './_helpers/output';
import {
  AGENT_RUN_GLOBAL_ARGS,
  GLOBAL_ARGS,
  collectCommonAgentRunFlags,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import { executeCliToolUseConfig } from '../runtime/runExecution';
import {
  toolUseResultText,
  type CliToolUseRunResult,
} from '../runtime/terminalStatus';
import { withExpandedRunInputs } from '../runtime/workflowInputs';

interface MultiAgentRunInit {
  readonly preset: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly agent?: string;
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

const MULTI_AGENT_TASK_REQUIRED_MESSAGE =
  'Provide --input, --instruction, or --instruction-file for the team task. Example: texra multi-agent run physicist --instruction "Check this derivation"';

function formatAttachedFileList(
  title: string,
  files: readonly string[],
): string | undefined {
  if (files.length === 0) return undefined;
  return [
    title,
    ...files.map((file) => {
      const spec = file.trim();
      return spec === '-' ? '- Standard input' : `- ${JSON.stringify(spec)}`;
    }),
  ].join('\n');
}

/** Preserve the user's launch input without copying model-only directives. */
function formatMultiAgentDisplayInstruction(
  instruction: string,
  inputFiles: readonly string[],
  contextFiles: readonly string[],
): string {
  if (instruction) return instruction;

  return [
    formatAttachedFileList('Attached input files:', inputFiles),
    formatAttachedFileList('Attached read-only context files:', contextFiles),
  ]
    .filter(filterNotNullish)
    .join('\n\n');
}

function headlessAskMultiAgentMessage(presetId: string): string {
  return `Cannot run multi-agent preset "${presetId}" with headless approval policy "ask": delegation prompts cannot be answered. Use an interactive run to answer prompts, pass --approval-policy never to deny approval-gated tools, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.`;
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
  const { plans, remoteCatalogRefreshAttempted } =
    await loadCliMultiAgentPresetPlanSet(presets);
  const records = cliMultiAgentPresetListRecords(plans);

  emitCliResult(context, {
    json: records,
    ndjson: cliMultiAgentPresetNdjsonRecords(plans),
    text: formatCliMultiAgentPresetList(plans, {
      includeLoginHint: !remoteCatalogRefreshAttempted,
    }),
  });
  return CliExitCode.Success;
}

async function runMultiAgentShow(
  context: CliContext,
  presetIdOrName: string,
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });

  const { plan, remoteCatalogRefreshAttempted } =
    await loadCliMultiAgentRunPlan({
      preset: presetIdOrName,
    });

  emitCliResult(context, {
    json: plan,
    ndjson: { kind: 'multi-agent-preset-inspection', plan },
    text: formatCliMultiAgentPresetInspection(plan, {
      includeLoginHint: !remoteCatalogRefreshAttempted,
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

  const rejectsHeadlessAsk =
    context.mode === 'headless' && context.approvalPolicy === 'ask';
  const { plan, remoteCatalogRefreshAttempted } =
    await loadCliMultiAgentRunPlan(init, {
      reloadRemoteAgents: !rejectsHeadlessAsk,
    });
  if (rejectsHeadlessAsk) {
    writeTextStderr(headlessAskMultiAgentMessage(plan.preset.id));
    return CliExitCode.Usage;
  }
  if (remoteCatalogRefreshAttempted) {
    const inspectAdvice = `Run \`texra multi-agent show ${plan.preset.id}\` to view the resolved team.`;
    // Otherwise the silent second load makes runs behave differently from a
    // signed-out shell with no visible reason.
    writeTextStderr(
      teamPlanHasGaps(plan)
        ? `Preset ${plan.preset.id} attempted to load remote agents before launch, but some team members are still unavailable. ${inspectAdvice}`
        : `Preset ${plan.preset.id} loaded remote agents before launch. ${inspectAdvice}`,
    );
  }
  if (plan.missingAgentOverride) {
    throw new CliUsageError(
      missingToolUseAgentMessage(plan.missingAgentOverride),
    );
  }
  if (!canLaunchTeam(plan)) {
    const singleAgentAdvice = plan.rootAgent
      ? `Start a single-agent chat with \`texra chat --agent ${plan.rootAgent.name}\` if that is what you want.`
      : 'Install or sign in for a runnable team root before launching this preset.';
    writeTextStderr(
      formatCliMultiAgentTeamLaunchBlockMessage(plan, {
        requestedPreset: init.preset,
        followUpAdvice: singleAgentAdvice,
      }),
    );
    return CliExitCode.Usage;
  }
  const rootAgent = plan.rootAgent;
  writeMissingPresetAgents(plan);

  // A team run drives a tool-use orchestrator, so it follows the `chat`
  // (tool-use) model config rather than `run` (workflow agents). Resolve the
  // model after agent validation so usage errors stay focused on bad agents.
  const model = await selectCliRunModel(context, init.model, 'chat');
  const runContext = buildHeadlessRunContext(context);
  return withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    runContext.cwd,
    {
      allowEmptyInput: hasInstruction,
      requireWorkspaceFiles: true,
      readStdinText: readCliStdinText,
    },
    async ({ inputFiles, contextFiles, hasMaterializedStdinInput }) => {
      if (runContext.approvalPolicy === 'never') {
        writeTextStderr(
          `WARN preset ${plan.preset.id} may run without subagent delegation because approval policy "never" denies approval-gated delegation tools. Use an interactive run to answer prompts, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.`,
        );
      }

      const displayInstruction = formatMultiAgentDisplayInstruction(
        instruction,
        init.inputFiles,
        init.contextFiles,
      );
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
          workingDirectory: runContext.cwd,
        }),
        displayInstruction,
        workingDirectory: runContext.cwd,
        agentCategory: AgentCategory.ToolUse,
        cliMultiAgentPresetId: plan.preset.id,
        delegationAgentScope: byCategory((category) => [
          ...plan.agentKeys[category],
        ]),
      };

      const execution = await executeCliToolUseConfig(config, runContext, {
        enforceCategory: true,
        stopAfterCycle: true,
        recoveryInputIsDurable: hasMaterializedStdinInput !== true,
        categoryMismatchMessage: `Multi-agent preset "${init.preset}" resolved to a non tool-use execution.`,
      });
      if (!execution.ok) return execution.exitCode;

      writeMultiAgentRunResult(runContext, plan, execution.result);

      return execution.exitCode;
    },
  );
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
  meta: {
    name: 'show',
    description: 'Show one multi-agent team preset and its resolved agents',
  },
  args: multiAgentPresetArgs,
  run: (context, ctx) => runMultiAgentShow(context, ctx.args.preset),
});

const multiAgentRunCommand = withUsageSections(
  defineCliCommand({
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
        ...collectCommonAgentRunFlags(ctx.rawArgs, ctx.args.instruction),
        agent: optString(ctx.args.agent),
        model: optString(ctx.args.model),
      }),
  }),
  [
    {
      title: 'RUN MODE',
      rows: [
        [
          'direct',
          'executes the team in the terminal and exits after the final response',
        ],
        [
          'rich TUI',
          'use `texra orchestrate` to pick a team from the launcher and keep chat/subagent panes open',
        ],
      ],
    },
  ],
);

export const multiAgentCommand = defineCommand({
  meta: {
    name: 'multi-agent',
    description: 'List, show, and run multi-agent team presets',
  },
  subCommands: {
    list: multiAgentListCommand,
    show: multiAgentShowCommand,
    run: multiAgentRunCommand,
  },
});
