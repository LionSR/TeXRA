import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { type CliApiMode } from '@cli/runtime/apiAccessMode';
import {
  loadCliApiStatusLines,
  loadCliModelAccessOverview,
} from '@cli/runtime/apiStatus';
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
  selectCliApiModelAccessRoute,
  selectCliModelAccessRoute,
} from '@cli/runtime/modelAccessSelection';

import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import type { ApiProvider } from '@model/apiProviders';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './slashContext';

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

/** Save a provider key, select personal access, and reconcile the root model. */
export async function applyCliProviderApiKey(
  provider: ApiProvider,
  key: string,
  context?: SlashCommandContext,
): Promise<string | undefined> {
  await saveProviderApiKey(provider, key);
  const access = await selectCliApiModelAccessRoute('personal');
  refreshCodexPreferenceViews();
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

/** Set the chat session's api-mode without touching the persisted global. */
export function setCliSessionApiMode(apiMode: CliApiMode): void {
  patchSessionMeta({ apiMode });
}

export async function applyCliModelAccessSelection(
  routeInput: string,
  context: SlashCommandContext,
): Promise<void> {
  const normalized = routeInput.trim().toLowerCase();

  if (!normalized || normalized === 'status') {
    const apiMode = sessionMeta.get().apiMode;
    const [{ lines }, apiStatusLines] = await Promise.all([
      loadCliModelAccessOverview({ apiMode }),
      loadCliApiStatusLines({ apiMode }),
    ]);
    const detailLines = apiStatusLines
      .slice(2)
      .filter((line) => !lines.includes(line));
    appendLocalAssistantTranscript(
      [...lines, ...detailLines, MODEL_ACCESS_USAGE].join('\n'),
    );
    return;
  }

  const route = parseCliModelAccessRoute(normalized);
  if (route) {
    const access = await selectCliModelAccessRoute(
      contextForCliModelAccess(context.cliContext, sessionMeta.get().apiMode),
      route,
      { writeProgress: appendLocalAssistantTranscript },
    );
    refreshCodexPreferenceViews();
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
    appendLocalAssistantTranscript(
      [access.message, ...(modelNotice ? [modelNotice] : [])].join('\n'),
    );
    return;
  }

  appendLocalAssistantTranscript(MODEL_ACCESS_USAGE);
}

export async function showCliAuthStatus(): Promise<void> {
  const { lines } = await loadCliModelAccessOverview({
    apiMode: sessionMeta.get().apiMode,
  });
  appendLocalAssistantTranscript(lines.join('\n'));
}
