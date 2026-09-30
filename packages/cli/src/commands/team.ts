import { Effect } from 'effect';
import { defineCommand } from 'citty';

import { getCategoryAgent } from '@agent/index';
import type { AgentConfigPayload } from '@agent/runtime';
import { canLaunchTeam, planTeamRuns } from '@common/teams/TeamPlan';
import { byCategory, AgentCategory } from '@shared/schemas';
import { filterNotNullish } from '@utils/core';

import { missingToolUseAgentMessage } from '../runtime/agents';
import {
  failUsage,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import {
  initCliPlatform,
  type CliPlatformServices,
} from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  cliTeamListRecord,
  cliTeamNdjsonRecords,
  formatCliTeamLaunchBlockMessage,
  formatCliTeamInspection,
  formatCliTeamList,
  readCliTeams,
} from '../runtime/cliTeams';
import {
  loadCliTeamRunPlan,
  writeMissingPresetAgents,
} from '../runtime/teamRunPlan';
import {
  buildHeadlessRunContext,
  selectCliRunModel,
} from '../runtime/runModel';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { formatTeamRunInstruction } from './_helpers/runInstructions';
import { emitCliResult } from './_helpers/output';
import {
  AGENT_RUN_GLOBAL_ARGS,
  GLOBAL_ARGS,
  collectCommonAgentRunFlags,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import {
  type CliRunServices,
  executeCliToolUseConfig,
} from '../runtime/executeCli';
import { toolUseResultText } from '../runtime/terminalStatus';
import { withExpandedRunInputs } from '../runtime/workflowInputs';

interface TeamRunInit {
  readonly preset: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly agent?: string;
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

const TEAM_TASK_REQUIRED_MESSAGE =
  'Provide --input, --instruction, or --instruction-file for the team task. Example: texra team run physicist --instruction "Check this derivation"';

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

const runTeamList = Effect.fn('runTeamList')(function* (
  context: CliContext,
  services: CliPlatformServices,
) {
  const plans = planTeamRuns(yield* readCliTeams(services.repoState), {
    resolveAgent: getCategoryAgent,
  });

  emitCliResult(context, {
    json: plans.map(cliTeamListRecord),
    ndjson: cliTeamNdjsonRecords(plans),
    text: formatCliTeamList(plans),
  });
  return CliExitCode.Success;
});

const runTeamShow = Effect.fn('runTeamShow')(function* (
  context: CliContext,
  presetIdOrName: string,
  services: CliPlatformServices,
) {
  const plan = yield* loadCliTeamRunPlan(
    { preset: presetIdOrName },
    services.repoState,
  );

  emitCliResult(context, {
    json: plan,
    ndjson: { kind: 'team-inspection', plan },
    text: formatCliTeamInspection(plan),
  });
  return CliExitCode.Success;
});

export const runTeam = Effect.fn('runTeam')(function* (
  context: CliContext,
  init: TeamRunInit,
): Effect.fn.Return<number, Error, CliRunServices> {
  const instruction = yield* resolveFileBackedInstruction(init, context.cwd);
  const hasInstruction = instruction.trim().length > 0;
  if (init.inputFiles.length === 0 && !hasInstruction) {
    return yield* failUsage(TEAM_TASK_REQUIRED_MESSAGE);
  }
  const services = yield* initCliPlatform(context);

  const rejectsHeadlessAsk =
    context.mode === 'headless' && context.approvalPolicy === 'ask';
  const plan = yield* loadCliTeamRunPlan(init, services.repoState);
  if (rejectsHeadlessAsk) {
    writeTextStderr(
      `Cannot run team "${plan.preset.id}" with headless approval policy "ask": delegation prompts cannot be answered. Use an interactive run to answer prompts, pass --approval-policy never to deny approval-gated tools, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.`,
    );
    return CliExitCode.Usage;
  }
  if (plan.missingAgentOverride) {
    return yield* failUsage(
      missingToolUseAgentMessage(plan.missingAgentOverride),
    );
  }
  if (!canLaunchTeam(plan)) {
    const singleAgentAdvice = plan.rootAgent
      ? `Start a single-agent chat with \`texra chat --agent ${plan.rootAgent.name}\` if that is what you want.`
      : 'Install or create a runnable team root before launching this team.';
    writeTextStderr(
      formatCliTeamLaunchBlockMessage(plan, {
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
  const model = yield* selectCliRunModel(context, init.model, 'chat', services);
  const runContext = buildHeadlessRunContext(context);
  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    runContext.cwd,
    {
      allowEmptyInput: hasInstruction,
      requireWorkspaceFiles: true,
      readStdinText: readCliStdinText,
    },
    ({ inputFiles, contextFiles, stdinInputPath }) =>
      Effect.gen(function* () {
        if (runContext.approvalPolicy === 'never') {
          writeTextStderr(
            `WARN team ${plan.preset.id} may run without subagent delegation because approval policy "never" denies approval-gated delegation tools. Use an interactive run to answer prompts, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.`,
          );
        }

        // Preserve the user's launch input without copying the model-only
        // directive assembled into config.instruction below.
        const displayInstruction =
          instruction ||
          [
            formatAttachedFileList('Attached input files:', init.inputFiles),
            formatAttachedFileList(
              'Attached read-only context files:',
              init.contextFiles,
            ),
          ]
            .filter(filterNotNullish)
            .join('\n\n');
        const config: AgentConfigPayload = {
          agent: rootAgent.name,
          agentSource: rootAgent.source,
          model,
          inputFiles,
          contextFiles,
          instruction: formatTeamRunInstruction(plan.preset, {
            inputFiles,
            contextFiles,
            instruction,
            approvalContext: runContext,
            workingDirectory: runContext.cwd,
          }),
          displayInstruction,
          workingDirectory: runContext.cwd,
          agentCategory: AgentCategory.ToolUse,
          cli: { multiAgentPresetId: plan.preset.id },
          delegationAgentScope: byCategory((category) => [
            ...plan.agentKeys[category],
          ]),
        };

        const run = yield* executeCliToolUseConfig(config, runContext, {
          session: services.session,
          runtime: services.runtime,
          shutdownScope: services.shutdownScope,
          stopAfterCycle: true,
          recoveryInputIsDurable: stdinInputPath === undefined,
        });
        if (!run.ok) return run.exitCode;

        const payload = {
          preset: {
            id: plan.preset.id,
            name: plan.preset.name,
            source: plan.preset.source,
          },
          rootAgent: rootAgent.name,
          result: run.result,
        };
        emitCliResult(runContext, {
          json: payload,
          ndjson: { kind: 'team-result', ...payload },
          text: toolUseResultText(run.result),
        });

        return run.exitCode;
      }),
  );
});

const teamListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List teams' },
  args: {
    ...GLOBAL_ARGS,
  },
  run: (context) =>
    Effect.gen(function* () {
      const services = yield* initCliPlatform(context);
      return yield* runTeamList(context, services);
    }),
});

const teamShowCommand = defineCliCommand({
  meta: {
    name: 'show',
    description: 'Show one team and its resolved agents',
  },
  args: {
    ...GLOBAL_ARGS,
    preset: {
      type: 'positional',
      required: true,
      description: 'Team id or name from `texra team list`',
    },
  },
  run: (context, ctx) =>
    Effect.gen(function* () {
      const services = yield* initCliPlatform(context);
      return yield* runTeamShow(context, ctx.args.preset, services);
    }),
});

const teamRunCommand = withUsageSections(
  defineCliCommand({
    meta: { name: 'run', description: 'Run a team' },
    args: {
      ...AGENT_RUN_GLOBAL_ARGS,
      preset: {
        type: 'positional',
        required: true,
        description: 'Team id or name from `texra team list`',
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
        description: 'Root agent for the team run (defaults to the team lead)',
      },
      model: {
        type: 'string',
        alias: 'm',
        description: 'Model for the team root agent',
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
      runTeam(context, {
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
        ['rich TUI', 'use `texra chat` and ask the team lead in the session'],
      ],
    },
  ],
);

export const teamCommand = defineCommand({
  meta: {
    name: 'team',
    description: 'List, show, and run teams',
  },
  subCommands: {
    list: teamListCommand,
    show: teamShowCommand,
    run: teamRunCommand,
  },
});
