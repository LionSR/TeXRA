// Third-party imports
import * as vscode from 'vscode';

// Local imports - platform
import {
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
  type LanguageModelInfo,
  type LanguageModelMessage,
  type LanguageModelPort,
  type LanguageModelRequestOptions,
  type LanguageModelResponsePart,
} from '@platform/languageModel';

const NOOP_DISPOSABLE = Object.freeze({ dispose() {} });

function toModelInfo(model: vscode.LanguageModelChat): LanguageModelInfo {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    vendor: model.vendor,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
  };
}

function toVscodeMessage(
  message: LanguageModelMessage,
): vscode.LanguageModelChatMessage {
  if (message.role === 'assistant') {
    return vscode.LanguageModelChatMessage.Assistant(
      message.content.map((part) =>
        part.kind === 'text'
          ? new vscode.LanguageModelTextPart(part.text)
          : new vscode.LanguageModelToolCallPart(
              part.callId,
              part.name,
              part.input,
            ),
      ),
    );
  }

  return vscode.LanguageModelChatMessage.User(
    message.content.map((part) =>
      part.kind === 'text'
        ? new vscode.LanguageModelTextPart(part.text)
        : new vscode.LanguageModelToolResultPart(part.callId, [
            new vscode.LanguageModelTextPart(part.text),
          ]),
    ),
  );
}

function toVscodeOptions(
  options: LanguageModelRequestOptions,
): vscode.LanguageModelChatRequestOptions {
  return {
    justification: options.justification,
    tools: options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    toolMode:
      options.toolMode === undefined
        ? undefined
        : options.toolMode === 'required'
          ? vscode.LanguageModelChatToolMode.Required
          : vscode.LanguageModelChatToolMode.Auto,
  };
}

async function findModel(
  selectChatModels: typeof vscode.lm.selectChatModels,
  modelId: string,
): Promise<vscode.LanguageModelChat | undefined> {
  const models = await selectChatModels({ id: modelId });
  return models.find((model) => model.id === modelId);
}

async function requireModel(
  selectChatModels: typeof vscode.lm.selectChatModels,
  modelId: string,
): Promise<vscode.LanguageModelChat> {
  const model = await findModel(selectChatModels, modelId);
  if (!model) {
    throw new Error(`Language model "${modelId}" is unavailable.`);
  }
  return model;
}

async function* streamResponse(
  selectChatModels: typeof vscode.lm.selectChatModels,
  modelId: string,
  messages: readonly LanguageModelMessage[],
  options: LanguageModelRequestOptions,
  signal: AbortSignal,
): AsyncIterable<LanguageModelResponsePart> {
  const model = await requireModel(selectChatModels, modelId);
  const cancellation = new vscode.CancellationTokenSource();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    cancellation.cancel();
  };
  if (signal.aborted) cancel();
  signal.addEventListener('abort', cancel, { once: true });

  try {
    const response = await model.sendRequest(
      messages.map(toVscodeMessage),
      toVscodeOptions(options),
      cancellation.token,
    );
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        yield { kind: 'text', text: part.value };
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        yield {
          kind: 'toolCall',
          callId: part.callId,
          name: part.name,
          input: part.input,
        };
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    cancellation.dispose();
  }
}

/** Create the VS Code implementation, or the shared unavailable port. */
export function createLanguageModelPort(
  context: vscode.ExtensionContext,
): LanguageModelPort {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  if (typeof lm?.selectChatModels !== 'function') {
    return UNAVAILABLE_LANGUAGE_MODEL_PORT;
  }
  const selectChatModels = lm.selectChatModels;
  const accessInformation = (
    context as {
      languageModelAccessInformation?: Partial<vscode.LanguageModelAccessInformation>;
    }
  ).languageModelAccessInformation;

  return {
    isAvailable: () => true,

    async selectModels(selector) {
      return (await selectChatModels(selector)).map(toModelInfo);
    },

    onDidChangeModels(listener) {
      return typeof lm.onDidChangeChatModels === 'function'
        ? lm.onDidChangeChatModels(listener)
        : NOOP_DISPOSABLE;
    },

    sendRequest(modelId, messages, options, signal) {
      return streamResponse(
        selectChatModels,
        modelId,
        messages,
        options,
        signal,
      );
    },

    async countTokens(modelId, text) {
      return (await requireModel(selectChatModels, modelId)).countTokens(text);
    },

    async canSendRequest(modelId) {
      if (typeof accessInformation?.canSendRequest !== 'function') {
        return undefined;
      }
      const model = await findModel(selectChatModels, modelId);
      return model === undefined
        ? undefined
        : accessInformation.canSendRequest(model);
    },

    onDidChangeAccess(listener) {
      return typeof accessInformation?.onDidChange === 'function'
        ? accessInformation.onDidChange(listener)
        : NOOP_DISPOSABLE;
    },
  };
}
