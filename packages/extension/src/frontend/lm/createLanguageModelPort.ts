// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { warn } from '@logger/logUtils';
import {
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
  type LanguageModelAccessState,
  type LanguageModelInfo,
  type LanguageModelPort,
} from '@platform/languageModel';
import { toErrorMessage } from '@utils/errors/errorMessage';

function toAccessState(access: boolean | undefined): LanguageModelAccessState {
  if (access === true) return 'allowed';
  if (access === false) return 'unavailable';
  return 'consent-required';
}

function toModelInfo(
  model: vscode.LanguageModelChat,
  accessInformation: vscode.LanguageModelAccessInformation,
): LanguageModelInfo {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    vendor: model.vendor,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
    access: toAccessState(accessInformation.canSendRequest(model)),
  };
}

/** Create the VS Code language-model implementation. */
export function createLanguageModelPort(
  context: vscode.ExtensionContext,
): LanguageModelPort {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  if (typeof lm?.selectChatModels !== 'function') {
    // Compatible non-VS Code hosts can expose only part of the `vscode.lm`
    // namespace — the same boundary `registerLanguageModelTools` guards.
    // Report unavailability through `isAvailable()` instead of throwing
    // during activation.
    return UNAVAILABLE_LANGUAGE_MODEL_PORT;
  }
  const lmApi = lm as typeof vscode.lm;
  const selectChatModels = lmApi.selectChatModels;
  const accessInformation = context.languageModelAccessInformation;

  return {
    isAvailable: () => true,

    selectModels: (selector) =>
      Effect.tryPromise({
        try: async () =>
          (await selectChatModels(selector)).map((model) =>
            toModelInfo(model, accessInformation),
          ),
        // The editor's own error travels on unchanged: the one production
        // consumer (`runtimeModelRegistry`) hands it to the caller that asked
        // for discovery, which reads its message.
        catch: (cause) => cause,
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            warn(
              'LanguageModelPort',
              `Could not discover editor-supplied language models: ${toErrorMessage(error)}`,
            ),
          ),
        ),
      ),

    onDidChange(listener) {
      const models = lmApi.onDidChangeChatModels(listener);
      const access = accessInformation.onDidChange(listener);
      return {
        dispose() {
          models.dispose();
          access.dispose();
        },
      };
    },
  };
}
