import { defineCommand, showUsage } from 'citty';

import { getVisibleAgents, loadAgents } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';

import { CliExitCode } from '../runtime/exitCodes';
import { listCliHistoryEntries } from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  readCliMultiAgentPresets,
  withCliMultiAgentPresetVisibility,
} from '../runtime/multiAgentPresets';
import { buildCliOrchestrationItems } from '../runtime/orchestration';

import { contextFromArgs } from './_helpers/context';
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
        : 'texra orchestrate needs a capable terminal — TERM=dumb strips the cursor controls Ink uses.',
    );
    return CliExitCode.Usage;
  }

  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  await loadAgents({ includeRemote: false });
  const history = await listCliHistoryEntries();
  const items = buildCliOrchestrationItems({
    presets: readCliMultiAgentPresets(),
    history,
    toolUseAgents: getVisibleAgents(AgentCategory.ToolUse),
  });
  const { runOrchestrationTui } =
    await import('../orchestration/runOrchestrationTui');
  const action = await runOrchestrationTui(items);

  switch (action.kind) {
    case 'chat': {
      const { runChat } = await import('../chat/tui/runChatTui');
      const result = await runChat(context, {
        agentOverride: action.agent,
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

export const orchestrationCommand = defineCommand({
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
});
