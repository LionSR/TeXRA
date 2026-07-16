import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  parseCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from '@cli/runtime/apiAccessMode';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import { formatCliModelAccessRouteInline } from '@cli/runtime/modelAccessRoute';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';

import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
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
  if (!context || !chatTuiCanStartRootRun(context.session)) return undefined;

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
    await setCliApiMode(apiMode);
    setCliSessionApiMode(apiMode);
    let modelNotice: string | undefined;
    try {
      modelNotice = await reconcileRootModelAfterApiModeChange(
        context,
        apiMode,
      );
    } catch (error: unknown) {
      modelNotice = toErrorMessage(error);
    }
    appendLocalAssistantTranscript(
      [
        `API mode set to ${formatCliModelAccessRouteInline(apiMode)}.`,
        ...(modelNotice ? [modelNotice] : []),
      ].join('\n'),
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
