import { defineCommand, showUsage } from 'citty';

import { getVisibleAgents } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { CliExitCode } from '../runtime/exitCodes';
import { listCliHistoryEntries } from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';
import {
  cliMultiAgentPresetTeamLaunchBlockReason,
  readCliMultiAgentPresets,
  withCliMultiAgentPresetVisibility,
} from '../runtime/multiAgentPresets';
import { buildCliOrchestrationItems } from '../runtime/orchestration';
import {
  cliRunnableModelOptionsForSource,
  getCliModelAccessList,
  resolveCliRunnableModelWithAccessList,
  runnableCliModelAccessEntries,
  type CliModelAccess,
} from '../runtime/modelAccess';
import { effectiveCliApiMode } from '../runtime/apiAccessMode';
import { notifyCliUpdate } from '../runtime/updateChecker';
import { resolveChatDefaults } from '../runtime/chatDefaults';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_AGENT_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import {
  fillMultiAgentRunPlanGaps,
  loadCliMultiAgentPresetPlans,
  writeMissingPresetAgents,
} from './multiAgent';
import { runResumeExecution } from './resume';
import type { CliContext } from '../runtime/cliContext';

async function canLaunchWithDefaultModel(
  context: CliContext,
  models: readonly CliModelAccess[],
  apiMode: ReturnType<typeof effectiveCliApiMode>,
): Promise<boolean> {
  if (
    models.length === 0 ||
    runnableCliModelAccessEntries(models, apiMode).length > 0
  ) {
    return true;
  }

  const defaults = await resolveChatDefaults({
    cwd: context.cwd,
    envAgent: context.envAgent,
    envModel: context.envModel,
  });
  try {
    await resolveCliRunnableModelWithAccessList(
      models,
      defaults.model,
      cliRunnableModelOptionsForSource(defaults.modelSource, { apiMode }),
    );
    return true;
  } catch {
    return false;
  }
}

async function runOrchestration(context: CliContext): Promise<number> {
  const terminalFailure = interactiveTerminalFailure(context);
  if (terminalFailure) {
    writeTextStderr(
      formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage:
          'texra orchestrate requires an interactive terminal (TTY stdin and stdout). For scripting, use `texra run` or a concrete subcommand.',
        dumbTerminalCommand: 'orchestrate',
      }),
    );
    return CliExitCode.Usage;
  }

  await notifyCliUpdate(context);

  await initCliPlatform({
    ...context,
    quietLogs: true,
    bestEffortIncludedModelAccess: true,
  });
  // First-run gate: a credential-less interactive user picks sign-in or a key
  // here instead of landing on a launcher full of "login required" models. On
  // success the apiMode/models read below re-reads the freshly-set credentials
  // in-process — the relay / key paths invalidate the relevant caches — so no
  // relaunch is needed.
  const { maybeRunCliOnboarding } = await import('../onboarding/runOnboarding');
  const onboarding = await maybeRunCliOnboarding(context);
  if (onboarding.declined) {
    // The user saw the picker and chose "Skip for now"; the skip summary already
    // printed. Exit cleanly instead of dropping into a launcher full of
    // "login required" models — same opt-out behavior as `texra chat`.
    return CliExitCode.Success;
  }
  const history = await listCliHistoryEntries();
  const presets = readCliMultiAgentPresets();
  const items = buildCliOrchestrationItems({
    presetPlans: await loadCliMultiAgentPresetPlans(presets),
    history,
    toolUseAgents: getVisibleAgents(AgentCategory.ToolUse),
  });
  // Load the model registry up front so the launcher can offer a model pick
  // after an agent/team choice. Best-effort: an unavailable registry just
  // launches with the default model instead of blocking the launcher.
  const apiMode = effectiveCliApiMode(context);
  const models: readonly CliModelAccess[] = await getCliModelAccessList({
    apiMode,
  }).catch(() => []);
  const allowDefaultModelLaunch = await canLaunchWithDefaultModel(
    context,
    models,
    apiMode,
  );
  const { runOrchestrationTui } =
    await import('../orchestration/runOrchestrationTui');
  const action = await runOrchestrationTui(items, {
    models,
    apiMode,
    allowDefaultModelLaunch,
    colorEnabled: context.stdoutColorEnabled ?? context.colorEnabled,
  });

  switch (action.kind) {
    case 'chat': {
      const { runChat } = await import('../chat/tui/runChatTui');
      const result = await runChat(context, {
        agentOverride: action.agent,
        modelOverride: action.model,
      });
      return result.exitCode;
    }
    case 'preset': {
      // Match the headless path: load remote premium agents (orchestrator,
      // delegation specialists) and replan so the team starts with its real
      // root instead of silently degrading to the first local tool-use agent.
      const plan = await fillMultiAgentRunPlanGaps({ preset: action.preset });
      const teamLaunchBlockReason =
        cliMultiAgentPresetTeamLaunchBlockReason(plan);
      if (teamLaunchBlockReason || !plan.rootAgent) {
        writeTextStderr(
          `Multi-agent preset "${action.preset}" cannot start as a team: ${teamLaunchBlockReason ?? 'no runnable team root'}. Run \`texra multi-agent inspect ${plan.preset.id}\` to see missing agents.`,
        );
        return CliExitCode.Usage;
      }
      writeMissingPresetAgents(plan);
      const { runChat } = await import('../chat/tui/runChatTui');
      const result = await withCliMultiAgentPresetVisibility(plan, () =>
        runChat(context, {
          agentOverride: plan.rootAgent?.name,
          teamName: plan.preset.name,
          modelOverride: action.model,
          cliMultiAgentPresetId: plan.preset.id,
        }),
      );
      return result.exitCode;
    }
    case 'resume':
      return runResumeExecution(context, action.id);
    case 'help': {
      const { rootCommand } = await import('./root');
      await showUsage(rootCommand);
      return CliExitCode.Success;
    }
    case 'exit':
      return CliExitCode.Success;
  }
}

export const orchestrationCommand = withUsageSections(
  defineCommand({
    meta: {
      name: 'orchestrate',
      description:
        'Interactive launcher (runs by default on bare `texra` in a TTY): pick a chat, resume, or team preset',
    },
    args: {
      ...INTERACTIVE_AGENT_GLOBAL_ARGS,
    },
    async run(ctx) {
      rejectHeadlessOnlyFlags(ctx.rawArgs, 'orchestrate');
      const context = await contextFromArgs(ctx.args, ctx.rawArgs);
      setExitCode(await runOrchestration(context));
    },
  }),
  [
    {
      title: 'INTERACTIVE CONTROLS',
      rows: [
        ['↑/↓', 'navigate launcher items'],
        ['1-9/a-z', 'open an item directly'],
        ['Enter', 'open the selected item'],
        ['Esc', 'exit the launcher'],
      ],
    },
  ],
);
