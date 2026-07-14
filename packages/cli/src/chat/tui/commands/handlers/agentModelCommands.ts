import { getAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { assertCliAgentLaunch } from '@cli/runtime/agents';
import { CliUsageError } from '@cli/runtime/cliContext';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';

import {
  patchSessionMeta,
  sessionMeta,
  setCliSessionModelOverride,
} from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './slashContext';

export function chatAgentSupportsDelegation(agentName: string): boolean {
  return (
    getAgent(agentName, AgentCategory.ToolUse)?.tools?.some((toolName) =>
      DELEGATION_TOOLS.has(toolName),
    ) ?? false
  );
}

export function chatToolUseAgentUsageError(
  agentName: string,
): string | undefined {
  try {
    assertCliAgentLaunch(
      agentName,
      getAgent(agentName, AgentCategory.ToolUse),
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
  patchSessionMeta({
    agent: nextAgent,
    canDelegate: chatAgentSupportsDelegation(nextAgent),
    teamName: undefined,
    cliMultiAgentPresetId: undefined,
    delegationAgentScope: undefined,
  });
  appendLocalAssistantTranscript(`Root agent set to ${nextAgent}.`);
}

export async function applyCliModelSelection(
  model: string,
  context: SlashCommandContext,
): Promise<void> {
  const nextModel = model.trim();
  if (chatTuiCanStartRootRun(context.session)) {
    try {
      const { apiMode } = sessionMeta.get();
      const selection = await selectCliRunnableModel(nextModel, {
        fallbackReason: 'explicit-override',
        apiMode,
        noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
          apiMode,
          CHAT_API_MODE_MODEL_RECOVERY,
        ),
        agentCategory: AgentCategory.ToolUse,
      });
      await setCliHelperModel(selection.model);
      setCliSessionModelOverride(selection.model);
      appendLocalAssistantTranscript(`Root model set to ${selection.model}.`);
    } catch (error: unknown) {
      appendLocalAssistantTranscript(toErrorMessage(error));
    }
    return;
  }

  if (!context.canSelectModel()) {
    appendLocalAssistantTranscript(
      'Finish the active response before switching models.',
    );
    return;
  }

  const activeFlow = context.session.streamId
    ? defaultSession().executions.getToolUseFlowContext(
        context.session.streamId,
      )
    : undefined;
  if (!activeFlow) {
    appendLocalAssistantTranscript(
      'Model switching is only available for an active tool-use chat. Start a new chat with texra chat --model=<name> to choose a different root model.',
    );
    return;
  }

  try {
    await activeFlow.switchModel(nextModel);
    setCliSessionModelOverride(nextModel);
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
    return;
  }

  try {
    await setCliHelperModel(nextModel);
  } catch (error: unknown) {
    appendLocalAssistantTranscript(
      `Model switched to ${nextModel}. Could not persist it as the default helper model: ${toErrorMessage(error)}`,
    );
    return;
  }

  appendLocalAssistantTranscript(
    `Model switched to ${nextModel}. Future turns will use it.`,
  );
}
