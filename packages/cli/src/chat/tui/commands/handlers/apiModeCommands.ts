import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { parseCliApiMode, type CliApiMode } from '@cli/runtime/apiAccessMode';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';
import { saveProviderApiKey } from '@cli/runtime/providerApiKey';
import { selectCliApiModelAccessRoute } from '@cli/runtime/modelAccessSelection';

import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import type { ApiProvider } from '@model/apiProviders';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './slashContext';

const API_MODE_USAGE = 'Usage: /api personal | /api included';

async function reconcileRootModelAfterApiModeChange(
  context: SlashCommandContext | undefined,
  apiMode: CliApiMode,
): Promise<string | undefined> {
  if (!context) return undefined;
  if (!chatTuiCanStartRootRun(context.session)) {
    return 'This model access setting applies to new chats. The current chat keeps its existing model connection.';
  }

  const { model: currentModel, modelSource } = sessionMeta.get();
  const selection = await selectCliRunnableModel(currentModel, {
    fallbackReason: modelSource,
    apiMode,
    noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
      apiMode,
      CHAT_API_MODE_MODEL_RECOVERY,
    ),
    agentCategory: AgentCategory.ToolUse,
  });
  await setCliHelperModel(selection.model);
  if (selection.model === currentModel) return undefined;

  patchSessionMeta({ model: selection.model });
  return selection.notice;
}

/** Select an api-mode access route, apply it to the session, and reconcile the root model. */
async function applyApiModelAccessRoute(
  requestedMode: CliApiMode,
  context: SlashCommandContext | undefined,
): Promise<string> {
  const access = await selectCliApiModelAccessRoute(requestedMode);
  setCliSessionApiMode(access.apiMode);
  let modelNotice: string | undefined;
  try {
    modelNotice = await reconcileRootModelAfterApiModeChange(
      context,
      access.apiMode,
    );
  } catch (error: unknown) {
    modelNotice = toErrorMessage(error);
  }
  return [access.message, modelNotice].filter(Boolean).join('\n');
}

/** Save a provider key, select personal access, and reconcile the root model. */
export async function applyCliProviderApiKey(
  provider: ApiProvider,
  key: string,
  context?: SlashCommandContext,
): Promise<string | undefined> {
  await saveProviderApiKey(provider, key);
  return applyApiModelAccessRoute('personal', context);
}

/** Set the chat session's api-mode without touching the persisted global. */
export function setCliSessionApiMode(apiMode: CliApiMode): void {
  patchSessionMeta({ apiMode });
}

export async function applyCliApiModeSelection(
  mode: string | CliApiMode,
  context?: SlashCommandContext,
): Promise<void> {
  const normalized = mode.trim().toLowerCase();

  if (!normalized || normalized === 'status') {
    const lines = await loadCliApiStatusLines({
      apiMode: sessionMeta.get().apiMode,
    });
    appendLocalAssistantTranscript([...lines, API_MODE_USAGE].join('\n'));
    return;
  }

  const apiMode = parseCliApiMode(normalized);
  if (apiMode) {
    appendLocalAssistantTranscript(
      await applyApiModelAccessRoute(apiMode, context),
    );
    return;
  }

  appendLocalAssistantTranscript(API_MODE_USAGE);
}

export async function showCliAuthStatus(): Promise<void> {
  const lines = await loadCliApiStatusLines({
    apiMode: sessionMeta.get().apiMode,
  });
  appendLocalAssistantTranscript(lines.join('\n'));
}
