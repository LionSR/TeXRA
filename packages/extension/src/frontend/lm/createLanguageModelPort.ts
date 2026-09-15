// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { warn } from '@logger/logUtils';
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  LanguageModelPortError,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
  type LanguageModelAccessState,
  type LanguageModelInfo,
  type LanguageModelPort,
} from '@platform/languageModel';

function translateLanguageModelError(error: unknown): LanguageModelPortError {
  if (error instanceof LanguageModelPortError) return error;

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case 'NoPermissions':
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.NO_PERMISSIONS,
        'Access to language model was not granted. Allow TeXRA to use language models in VS Code and try again.',
        { cause: error },
      );
    case 'Blocked':
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.QUOTA_EXCEEDED,
        'Language model is blocked, usually because the Copilot quota has been exceeded.',
        { cause: error },
      );
    case 'NotFound':
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.MODEL_UNAVAILABLE,
        'Language model is unavailable. Select an available Copilot model and try again.',
        { cause: error },
      );
    default:
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.UNKNOWN,
        error instanceof Error && error.message
          ? error.message
          : 'Language model request failed.',
        { cause: error },
      );
  }
}

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

    async selectModels(selector) {
      try {
        return (await selectChatModels(selector)).map((model) =>
          toModelInfo(model, accessInformation),
        );
      } catch (error) {
        const translated = translateLanguageModelError(error);
        warn(
          'LanguageModelPort',
          'Could not discover editor-supplied language models.',
          { data: translated },
        );
        throw translated;
      }
    },

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
