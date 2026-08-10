import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { loadCliDetailedAccountStatusLines } from '@cli/runtime/apiStatus';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import { refreshSubscriptionPreferenceViews } from '@cli/chat/tui/state/codexSubscription';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';
import { saveProviderApiKey } from '@cli/runtime/providerApiKey';
import {
  cliApiFallbackSelection,
  parseCliModelAccessSelection,
  type CliModelAccessSelection,
} from '@cli/runtime/modelAccessRoute';
import {
  contextForCliModelAccess,
  type CliModelAccessSelectionResult,
  updateCliModelAccess,
} from '@cli/runtime/modelAccessSelection';

import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import type { ApiProvider } from '@model/apiProviders';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';
import { collapseWhitespace } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  abortableSlashCommand,
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandOutput,
  type SlashCommandContext,
  transcriptSlashCommandOutput,
} from './slashContext';

const MODEL_ACCESS_USAGE =
  'Usage: /api chatgpt | grok | kimi-code | glm-code | included | personal | status';

async function reconcileRootModelAfterApiModeChange(
  context: SlashCommandContext | undefined,
  apiMode: ApiAccessMode,
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
  return collapseWhitespace(
    [access.message, modelNotice].filter(Boolean).join(' · '),
  );
}

/** Save a provider key, select personal access, and reconcile the root model. */
export async function applyCliProviderApiKey(
  provider: ApiProvider,
  key: string,
  context?: SlashCommandContext,
): Promise<string | undefined> {
  await saveProviderApiKey(provider, key);
  const access = await updateCliModelAccess(
    context?.cliContext,
    cliApiFallbackSelection('personal'),
  );
  const message = await completeModelAccessSelection(access, context);
  if (provider !== 'kimiCode') return message;
  // The coding-only models route through the subscription automatically;
  // dual-backend K3 needs the opt-in switch, which is only discoverable if
  // we name it here.
  return collapseWhitespace(
    [
      message,
      "Tip: the Kimi for Coding models use your subscription automatically; to use it for Kimi K3 too, enable 'Prefer Kimi Code' in /config.",
    ]
      .filter(Boolean)
      .join(' · '),
  );
}

/** Set the session API mode and refresh access-dependent TUI views. */
export function setCliSessionApiMode(apiMode: ApiAccessMode): void {
  patchSessionMeta({ apiMode });
  refreshSubscriptionPreferenceViews();
}

async function applyCliModelAccessSelectionWithSignal(
  selection: CliModelAccessSelection,
  context: SlashCommandContext | undefined,
  output: SlashCommandOutput,
  signal: AbortSignal,
): Promise<void> {
  const cliContext =
    context == null
      ? undefined
      : contextForCliModelAccess(context.cliContext, sessionMeta.get().apiMode);
  const access = await updateCliModelAccess(cliContext, selection, {
    writeProgress: (message) =>
      output.writeProgress(message, { copyable: true }),
    signal,
  });
  output.appendOutcome(await completeModelAccessSelection(access, context));
}

export function applyCliModelAccessSelection(
  selection: CliModelAccessSelection,
  context: SlashCommandContext | undefined,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
): Promise<void> & { readonly abort: () => void } {
  return abortableSlashCommand((signal) =>
    applyCliModelAccessSelectionWithSignal(selection, context, output, signal),
  );
}

export function applyCliModelAccessInput(
  routeInput: string,
  context: SlashCommandContext,
  output: SlashCommandOutput = transcriptSlashCommandOutput,
): Promise<void> & { readonly abort: () => void } {
  return abortableSlashCommand(async (signal) => {
    const normalized = routeInput.trim().toLowerCase();

    if (!normalized || normalized === 'status') {
      const lines = await loadCliDetailedAccountStatusLines({
        apiMode: sessionMeta.get().apiMode,
      });
      output.appendOutcome(lines.join('\n'));
      return;
    }

    const selection = parseCliModelAccessSelection(normalized);
    if (!selection) {
      output.setNotice(MODEL_ACCESS_USAGE);
      return;
    }

    await applyCliModelAccessSelectionWithSignal(
      selection,
      context,
      output,
      signal,
    );
  });
}

export async function showCliAuthStatus(): Promise<void> {
  const lines = await loadCliDetailedAccountStatusLines({
    apiMode: sessionMeta.get().apiMode,
  });
  transcriptSlashCommandOutput.appendOutcome(lines.join('\n'));
}
