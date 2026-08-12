import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  assertCliAgentLaunch,
  chatAgentSupportsDelegation,
  resolveCliAgentInCategory,
} from '@cli/runtime/agents';
import { CliUsageError } from '@cli/runtime/cliContext';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';

import {
  patchSessionMeta,
  sessionMeta,
  setTransientNotice,
  setCliSessionModelOverride,
} from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { AgentCategory } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './slashContext';

export function chatToolUseAgentUsageError(
  agentName: string,
): string | undefined {
  try {
    assertCliAgentLaunch(
      agentName,
      resolveCliAgentInCategory(agentName, AgentCategory.ToolUse),
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
    setTransientNotice(
      'The agent is fixed for this chat session. Start a new chat to use a different agent.',
    );
    return;
  }

  const nextAgent = agentName.trim();
  const usageError = chatToolUseAgentUsageError(nextAgent);
  if (usageError) {
    setTransientNotice(usageError);
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
    const { apiMode } = sessionMeta.get();
    const selection = await selectCliRunnableModel(nextModel, {
      fallbackReason: 'explicit-override',
      apiMode,
      noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
        apiMode,
        CHAT_API_MODE_MODEL_RECOVERY,
      ),
    });
    await setCliHelperModel(selection.model);
    setCliSessionModelOverride(selection.model);
    appendLocalAssistantTranscript(`Root model set to ${selection.model}.`);
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

  await activeFlow.switchModel(nextModel);
  setCliSessionModelOverride(nextModel);
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
