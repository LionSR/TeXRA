// Local imports - platform
import type { Disposable } from './interfaces';

export interface LanguageModelInfo {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly vendor: string;
  readonly version: string;
  readonly maxInputTokens: number;
  /** Access reported by the host for this exact discovered model. */
  readonly access: LanguageModelAccessState;
}

export type LanguageModelAccessState =
  'allowed' | 'consent-required' | 'unavailable';

interface LanguageModelSelector {
  readonly vendor?: string;
  readonly family?: string;
  readonly version?: string;
  readonly id?: string;
}

/** Stable identity for a model whose id is scoped to its provider. */
export interface LanguageModelReference {
  readonly vendor: string;
  readonly id: string;
}

export interface LanguageModelTextPart {
  readonly kind: 'text';
  readonly text: string;
}

/** Binary image input passed to an editor-supplied language model. */
export interface LanguageModelDataPart {
  readonly kind: 'data';
  readonly data: Uint8Array;
  readonly mimeType: string;
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
        | LanguageModelTextPart
        | LanguageModelDataPart
        | LanguageModelToolResultPart
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

type LanguageModelTokenCountInput = string | LanguageModelMessage;

export const LANGUAGE_MODEL_PORT_ERROR_CODE = {
  HOST_UNAVAILABLE: 'host_unavailable',
  MODEL_UNAVAILABLE: 'model_unavailable',
  NO_PERMISSIONS: 'no_permissions',
  QUOTA_EXCEEDED: 'quota_exceeded',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
} as const;

export type LanguageModelPortErrorCode =
  (typeof LANGUAGE_MODEL_PORT_ERROR_CODE)[keyof typeof LANGUAGE_MODEL_PORT_ERROR_CODE];

/** Host-neutral failure from an editor-supplied language model API. */
export class LanguageModelPortError extends Error {
  readonly code: LanguageModelPortErrorCode;

  constructor(
    code: LanguageModelPortErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LanguageModelPortError';
    this.code = code;
  }
}

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
    model: LanguageModelReference,
    messages: readonly LanguageModelMessage[],
    options: LanguageModelRequestOptions,
    signal: AbortSignal,
  ): AsyncIterable<LanguageModelResponsePart>;
  countTokens(
    model: LanguageModelReference,
    input: LanguageModelTokenCountInput,
    signal?: AbortSignal,
  ): Promise<number>;
  onDidChangeAccess(listener: () => void): Disposable;
}

const UNAVAILABLE_MESSAGE =
  'Language models supplied by the editor are unavailable in this host.';

/** Shared implementation for CLI, desktop, tests, and unsupported editors. */
export const UNAVAILABLE_LANGUAGE_MODEL_PORT: LanguageModelPort = Object.freeze(
  {
    isAvailable: () => false,
    selectModels: async () => [],
    onDidChangeModels: () => ({ dispose() {} }),
    sendRequest: (): AsyncIterable<LanguageModelResponsePart> => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<LanguageModelResponsePart>> =>
          Promise.reject(
            new LanguageModelPortError(
              LANGUAGE_MODEL_PORT_ERROR_CODE.HOST_UNAVAILABLE,
              UNAVAILABLE_MESSAGE,
            ),
          ),
      }),
    }),
    countTokens: async () => {
      throw new LanguageModelPortError(
        LANGUAGE_MODEL_PORT_ERROR_CODE.HOST_UNAVAILABLE,
        UNAVAILABLE_MESSAGE,
      );
    },
    onDidChangeAccess: () => ({ dispose() {} }),
  },
);
