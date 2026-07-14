// Third-party imports
import * as vscode from 'vscode';

// Local imports - platform
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  LanguageModelPortError,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
  type LanguageModelInfo,
  type LanguageModelMessage,
  type LanguageModelPort,
  type LanguageModelRequestOptions,
  type LanguageModelReference,
  type LanguageModelResponsePart,
  type LanguageModelTokenCountInput,
} from '@platform/languageModel';

const NOOP_DISPOSABLE = Object.freeze({ dispose() {} });

function translateLanguageModelError(
  error: unknown,
  modelId?: string,
  signal?: AbortSignal,
): LanguageModelPortError {
  if (error instanceof LanguageModelPortError) return error;

  const model = modelId ? ` "${modelId}"` : '';
  if (signal?.aborted || error instanceof vscode.CancellationError) {
    return new LanguageModelPortError(
      LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED,
      `Language model${model} request was cancelled.`,
      { cause: error },
    );
  }

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case 'NoPermissions':
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.NO_PERMISSIONS,
        `Access to language model${model} was not granted. Allow TeXRA to use language models in VS Code and try again.`,
        { cause: error },
      );
    case 'Blocked':
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.QUOTA_EXCEEDED,
        `Language model${model} is blocked, usually because the Copilot quota has been exceeded.`,
        { cause: error },
      );
    case 'NotFound':
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.MODEL_UNAVAILABLE,
        `Language model${model} is unavailable. Select an available Copilot model and try again.`,
        { cause: error },
      );
    default:
      return new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.UNKNOWN,
        error instanceof Error && error.message
          ? error.message
          : `Language model${model} request failed.`,
        { cause: error },
      );
  }
}

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
  reference: LanguageModelReference,
): Promise<vscode.LanguageModelChat | undefined> {
  const models = await selectChatModels(reference);
  return models.find(
    (model) => model.id === reference.id && model.vendor === reference.vendor,
  );
}

async function requireModel(
  selectChatModels: typeof vscode.lm.selectChatModels,
  reference: LanguageModelReference,
): Promise<vscode.LanguageModelChat> {
  const model = await findModel(selectChatModels, reference);
  if (!model) {
    throw new LanguageModelPortError(
      LANGUAGE_MODEL_PORT_ERROR_CODE.MODEL_UNAVAILABLE,
      `Language model "${reference.id}" is unavailable. Select an available Copilot model and try again.`,
    );
  }
  return model;
}

function createCancellationBridge(
  modelId: string,
  signal?: AbortSignal,
): {
  readonly token: vscode.CancellationToken;
  throwIfCancelled(): void;
  dispose(): void;
} {
  const source = new vscode.CancellationTokenSource();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    source.cancel();
  };
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });

  return {
    token: source.token,
    throwIfCancelled() {
      if (signal?.aborted) {
        throw translateLanguageModelError(undefined, modelId, signal);
      }
    },
    dispose() {
      signal?.removeEventListener('abort', cancel);
      cancel();
      source.dispose();
    },
  };
}

async function* streamResponse(
  selectChatModels: typeof vscode.lm.selectChatModels,
  reference: LanguageModelReference,
  messages: readonly LanguageModelMessage[],
  options: LanguageModelRequestOptions,
  signal: AbortSignal,
): AsyncIterable<LanguageModelResponsePart> {
  const cancellation = createCancellationBridge(reference.id, signal);

  try {
    cancellation.throwIfCancelled();
    const model = await requireModel(selectChatModels, reference);
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
    // Some VS Code providers close the iterable without rejecting after the
    // cancellation token fires. Preserve cancellation as control flow.
    cancellation.throwIfCancelled();
  } catch (error) {
    throw translateLanguageModelError(error, reference.id, signal);
  } finally {
    cancellation.dispose();
  }
}

function toVscodeTokenCountInput(
  input: LanguageModelTokenCountInput,
): string | vscode.LanguageModelChatMessage {
  return typeof input === 'string' ? input : toVscodeMessage(input);
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
      try {
        return (await selectChatModels(selector)).map(toModelInfo);
      } catch (error) {
        throw translateLanguageModelError(error);
      }
    },

    onDidChangeModels(listener) {
      return typeof lm.onDidChangeChatModels === 'function'
        ? lm.onDidChangeChatModels(listener)
        : NOOP_DISPOSABLE;
    },

    sendRequest(model, messages, options, signal) {
      return streamResponse(selectChatModels, model, messages, options, signal);
    },

    async countTokens(reference, input, signal) {
      const cancellation = createCancellationBridge(reference.id, signal);
      try {
        cancellation.throwIfCancelled();
        const model = await requireModel(selectChatModels, reference);
        const count = await model.countTokens(
          toVscodeTokenCountInput(input),
          cancellation.token,
        );
        cancellation.throwIfCancelled();
        return count;
      } catch (error) {
        throw translateLanguageModelError(error, reference.id, signal);
      } finally {
        cancellation.dispose();
      }
    },

    async canSendRequest(reference) {
      try {
        if (typeof accessInformation?.canSendRequest !== 'function') {
          return undefined;
        }
        const model = await findModel(selectChatModels, reference);
        return model === undefined
          ? undefined
          : accessInformation.canSendRequest(model);
      } catch (error) {
        throw translateLanguageModelError(error, reference.id);
      }
    },

    onDidChangeAccess(listener) {
      return typeof accessInformation?.onDidChange === 'function'
        ? accessInformation.onDidChange(listener)
        : NOOP_DISPOSABLE;
    },
  };
}
