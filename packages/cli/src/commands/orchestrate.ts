import { defineCommand, showUsage } from 'citty';

import { platform } from '@platform/platform';
import { getFirstRunDone } from '@controllers/onboarding/onboardingFunnel';
import { getVisibleAgents } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { firstRunSetupAgentOverride } from '../onboarding/setupContinuation';
import { CliExitCode } from '../runtime/exitCodes';
import { listCliHistoryEntries } from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';
import {
  cliMultiAgentPresetCanLaunchTeam,
  formatCliMultiAgentTeamLaunchBlockMessage,
  readCliMultiAgentPresets,
  withCliMultiAgentPresetVisibility,
} from '../runtime/multiAgentPresets';
import {
  loadCliMultiAgentRunPlan,
  loadCliMultiAgentPresetPlanSet,
  writeMissingPresetAgents,
} from '../runtime/multiAgentRunPlan';
import { buildCliOrchestrationItems } from '../runtime/orchestration';
import {
  getCliModelAccessList,
  selectCliRunnableModel,
  type CliModelAccess,
} from '../runtime/modelAccess';
import { effectiveCliApiMode, type CliApiMode } from '../runtime/apiAccessMode';
import { loadCliApiStatusLines } from '../runtime/apiStatus';
import { notifyCliUpdate } from '../runtime/updateChecker';
import { resolveChatDefaults } from '../runtime/chatDefaults';
import { seedCliRosterFromDefaultTeam } from '../runtime/defaultTeamRoster';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_AGENT_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import { runResumeExecution } from '../runtime/resumeExecution';
import {
  resolveCliStdoutColorEnabled,
  type CliContext,
} from '../runtime/cliContext';

async function canLaunchWithDefaultModel(
  context: CliContext,
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
): Promise<boolean> {
  if (models.length === 0) return true;

  const defaults = await resolveChatDefaults({
    cwd: context.cwd,
    envAgent: context.envAgent,
    envModel: context.envModel,
  });
  try {
    await selectCliRunnableModel(defaults.model, {
      fallbackReason: defaults.modelSource,
      apiMode,
      accessList: models,
      agentCategory: AgentCategory.ToolUse,
    });
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
  // State 1 continuation (docs/prds/2026-06-11-agent-native-onboarding.md): on a true
  // first run the picker hands straight to a chat session owned by the setup
  // agent instead of the launcher. Existing users (firstRunDone backfilled or
  // earned) and users who pinned an agent via env land on the launcher as
  // before. `orchestrate` has no `--agent` flag here; the env override is the
  // only explicit agent pin this entry point honors.
  const setupAgentOverride = firstRunSetupAgentOverride({
    onboardingConfigured: onboarding.configured,
    firstRunDone: getFirstRunDone(platform().globalState),
    pinnedAgent: context.envAgent,
  });
  if (setupAgentOverride) {
    const { runChat } = await import('../chat/tui/runChatTui');
    const result = await runChat(context, {
      agentOverride: setupAgentOverride,
    });
    return result.exitCode;
  }
  const history = await listCliHistoryEntries();
  const presets = readCliMultiAgentPresets();
  const presetPlanSet = await loadCliMultiAgentPresetPlanSet(presets);
  await seedCliRosterFromDefaultTeam();
  const items = buildCliOrchestrationItems({
    presetPlans: presetPlanSet.plans,
    history,
    toolUseAgents: getVisibleAgents(AgentCategory.ToolUse),
    includeMultiAgentLoginHint: !presetPlanSet.remoteAgentLoadAttempted,
  });
  // Load the model registry up front so the launcher can offer a model pick
  // after an agent/team choice. Best-effort: an unavailable registry just
  // launches with the default model instead of blocking the launcher.
  const apiMode = effectiveCliApiMode(context);
  const [models, statusLines] = await Promise.all([
    getCliModelAccessList({
      apiMode,
      agentCategory: AgentCategory.ToolUse,
    }).catch((): readonly CliModelAccess[] => []),
    loadCliApiStatusLines({ apiMode, includeActionHint: true }),
  ]);
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
    version: context.version,
    statusLines,
    allowDefaultModelLaunch,
    colorEnabled: resolveCliStdoutColorEnabled(context),
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
      const { plan } = await loadCliMultiAgentRunPlan({
        preset: action.preset,
      });
      if (!cliMultiAgentPresetCanLaunchTeam(plan)) {
        writeTextStderr(
          formatCliMultiAgentTeamLaunchBlockMessage(plan, {
            requestedPreset: action.preset,
          }),
        );
        return CliExitCode.Usage;
      }
      const rootAgent = plan.rootAgent;
      writeMissingPresetAgents(plan);
      const { runChat } = await import('../chat/tui/runChatTui');
      const result = await withCliMultiAgentPresetVisibility(plan, () =>
        runChat(context, {
          agentOverride: rootAgent.name,
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
