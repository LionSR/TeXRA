// Local imports - platform
import type { Disposable } from './interfaces';

export interface LanguageModelInfo {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly vendor: string;
  readonly version: string;
  readonly maxInputTokens: number;
}

export interface LanguageModelSelector {
  readonly vendor?: string;
  readonly family?: string;
  readonly version?: string;
  readonly id?: string;
}

export interface LanguageModelTextPart {
  readonly kind: 'text';
  readonly text: string;
}

export interface LanguageModelToolCallPart {
  readonly kind: 'toolCall';
  readonly callId: string;
  readonly name: string;
  readonly input: object;
}

export interface LanguageModelToolResultPart {
  readonly kind: 'toolResult';
  readonly callId: string;
  readonly text: string;
}

export type LanguageModelMessage =
  | {
      readonly role: 'user';
      readonly content: readonly (
        LanguageModelTextPart | LanguageModelToolResultPart
      )[];
    }
  | {
      readonly role: 'assistant';
      readonly content: readonly (
        LanguageModelTextPart | LanguageModelToolCallPart
      )[];
    };

export interface LanguageModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: object;
}

export interface LanguageModelRequestOptions {
  /** Shown in the host's first-use consent prompt. */
  readonly justification?: string;
  readonly tools?: readonly LanguageModelToolDefinition[];
  readonly toolMode?: 'auto' | 'required';
}

export type LanguageModelResponsePart =
  LanguageModelTextPart | LanguageModelToolCallPart;

/**
 * Host bridge for subscription-backed language models exposed by the editor.
 * Hosts without such an API use {@link UNAVAILABLE_LANGUAGE_MODEL_PORT}.
 */
export interface LanguageModelPort {
  isAvailable(): boolean;
  selectModels(
    selector?: LanguageModelSelector,
  ): Promise<readonly LanguageModelInfo[]>;
  onDidChangeModels(listener: () => void): Disposable;
  sendRequest(
    modelId: string,
    messages: readonly LanguageModelMessage[],
    options: LanguageModelRequestOptions,
    signal: AbortSignal,
  ): AsyncIterable<LanguageModelResponsePart>;
  countTokens(modelId: string, text: string): Promise<number>;
  canSendRequest(modelId: string): Promise<boolean | undefined>;
  onDidChangeAccess(listener: () => void): Disposable;
}

const UNAVAILABLE_MESSAGE =
  'Language models supplied by the editor are unavailable in this host.';

function unavailableRequest(): AsyncIterable<LanguageModelResponsePart> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new Error(UNAVAILABLE_MESSAGE);
        },
      };
    },
  };
}

/** Shared implementation for CLI, desktop, tests, and unsupported editors. */
export const UNAVAILABLE_LANGUAGE_MODEL_PORT: LanguageModelPort = Object.freeze(
  {
    isAvailable: () => false,
    selectModels: async () => [],
    onDidChangeModels: () => ({ dispose() {} }),
    sendRequest: unavailableRequest,
    countTokens: async () => {
      throw new Error(UNAVAILABLE_MESSAGE);
    },
    canSendRequest: async () => undefined,
    onDidChangeAccess: () => ({ dispose() {} }),
  },
);
