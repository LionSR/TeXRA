import { defineCommand, showUsage } from 'citty';

import { getVisibleAgents, loadAgents } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { CliExitCode } from '../runtime/exitCodes';
import { listCliHistoryEntries } from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import { dumbTerminalMessage } from '../runtime/terminalRequirements';
import {
  readCliMultiAgentPresets,
  withCliMultiAgentPresetVisibility,
} from '../runtime/multiAgentPresets';
import { buildCliOrchestrationItems } from '../runtime/orchestration';
import {
  getCliModelAccessList,
  type CliModelAccess,
} from '../runtime/modelAccess';
import { effectiveCliApiMode } from '../runtime/apiAccessMode';
import { notifyCliUpdate } from '../runtime/updateChecker';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import {
  fillMultiAgentRunPlanGaps,
  writeMissingPresetAgents,
} from './multiAgent';
import { runResumeExecution } from './resume';
import type { CliContext } from '../runtime/cliContext';

async function runOrchestration(context: CliContext): Promise<number> {
  const isHeadless =
    context.mode === 'headless' || context.stdoutIsTty !== true;
  const dumbTerm = context.termIsDumb === true;
  if (isHeadless || dumbTerm) {
    writeTextStderr(
      isHeadless
        ? 'texra orchestrate requires an interactive terminal (TTY stdin and stdout). For scripting, use `texra run` or a concrete subcommand.'
        : dumbTerminalMessage('orchestrate'),
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
  await loadAgents({ includeRemote: false });
  const history = await listCliHistoryEntries();
  const items = buildCliOrchestrationItems({
    presets: readCliMultiAgentPresets(),
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
  const { runOrchestrationTui } =
    await import('../orchestration/runOrchestrationTui');
  const action = await runOrchestrationTui(items, { models, apiMode });

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
      if (!plan.rootAgent) {
        writeTextStderr(
          `Multi-agent preset "${action.preset}" has no available tool-use agent to start.`,
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
      ...INTERACTIVE_GLOBAL_ARGS,
    },
    async run(ctx) {
      rejectHeadlessOnlyFlags(ctx.rawArgs, 'orchestrate');
      const context = await contextFromArgs(ctx.args);
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
