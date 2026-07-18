import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { type CliApiMode } from '@cli/runtime/apiAccessMode';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import { refreshCodexPreferenceViews } from '@cli/chat/tui/state/codexSubscription';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';
import { saveProviderApiKey } from '@cli/runtime/providerApiKey';
import { parseCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import {
  contextForCliModelAccess,
  type CliModelAccessSelectionResult,
  selectCliApiModelAccessRoute,
  selectCliModelAccessRoute,
} from '@cli/runtime/modelAccessSelection';

import {
  patchSessionMeta,
  sessionMeta,
  setTransientNotice,
} from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import type { ApiProvider } from '@model/apiProviders';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './slashContext';
import { loadCliAccountStatusLines } from './statusAssembly';

const MODEL_ACCESS_USAGE = 'Usage: /api chatgpt | included | personal | status';

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

/** Apply an access selection to the TUI and reconcile the root model. */
async function completeModelAccessSelection(
  access: CliModelAccessSelectionResult,
  context: SlashCommandContext | undefined,
): Promise<string> {
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
  const access = await selectCliApiModelAccessRoute('personal');
  return completeModelAccessSelection(access, context);
}

/** Set the session API mode and refresh access-dependent TUI views. */
export function setCliSessionApiMode(apiMode: CliApiMode): void {
  patchSessionMeta({ apiMode });
  refreshCodexPreferenceViews();
}

export async function applyCliModelAccessSelection(
  routeInput: string,
  context: SlashCommandContext,
): Promise<void> {
  const normalized = routeInput.trim().toLowerCase();

  if (!normalized || normalized === 'status') {
    const apiMode = sessionMeta.get().apiMode;
    const lines = await loadCliAccountStatusLines({
      apiMode,
      includeApiDetails: true,
    });
    appendLocalAssistantTranscript(lines.join('\n'));
    return;
  }

  const route = parseCliModelAccessRoute(normalized);
  if (route) {
    const access = await selectCliModelAccessRoute(
      contextForCliModelAccess(context.cliContext, sessionMeta.get().apiMode),
      route,
      { writeProgress: appendLocalAssistantTranscript },
    );
    appendLocalAssistantTranscript(
      await completeModelAccessSelection(access, context),
    );
    return;
  }

  setTransientNotice(MODEL_ACCESS_USAGE);
}

export async function showCliAuthStatus(): Promise<void> {
  const lines = await loadCliAccountStatusLines({
    apiMode: sessionMeta.get().apiMode,
    includeApiDetails: true,
  });
  appendLocalAssistantTranscript(lines.join('\n'));
}
