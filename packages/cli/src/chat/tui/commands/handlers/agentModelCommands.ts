import {
  getRuntimeAgent,
  runtimeToolUseAgentHasAnyTool,
} from '@agent/runtime/agentResolution';
import { assertCliAgentLaunch } from '@cli/runtime/agents';
import { CliUsageError } from '@cli/runtime/cliContext';

import { cliState } from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { AgentCategory } from '@shared/schemas/agent';
import { type SlashCommandContext } from './slashContext';

export function chatAgentSupportsDelegation(agentName: string): boolean {
  return runtimeToolUseAgentHasAnyTool(agentName, DELEGATION_TOOLS);
}

export function chatToolUseAgentUsageError(
  agentName: string,
): string | undefined {
  try {
    assertCliAgentLaunch(
      agentName,
      getRuntimeAgent(agentName, AgentCategory.ToolUse),
      'chat',
    );
    return undefined;
  } catch (error) {
    if (error instanceof CliUsageError) return error.message;
    throw error;
  }
}

export function applyInitialCliAgentSelection(
  agentName: string,
  context: SlashCommandContext,
): void {
  if (!chatTuiCanStartRootRun(context.session)) {
    appendLocalAssistantTranscript(
      'Agent changes are only available before the first message. Use texra chat --agent <name> to choose a root agent in a new chat.',
    );
    return;
  }

  const nextAgent = agentName.trim();
  const usageError = chatToolUseAgentUsageError(nextAgent);
  if (usageError) {
    appendLocalAssistantTranscript(usageError);
    return;
  }
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    agent: nextAgent,
    canDelegate: chatAgentSupportsDelegation(nextAgent),
  });
  appendLocalAssistantTranscript(`Root agent set to ${nextAgent}.`);
}

export async function applyCliModelSelection(
  model: string,
  context: SlashCommandContext,
): Promise<void> {
  await context.switchModel(model);
}
