import { Context, Layer } from 'effect';

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

export const LANGUAGE_MODEL_PORT_ERROR_CODE = {
  MODEL_UNAVAILABLE: 'model_unavailable',
  NO_PERMISSIONS: 'no_permissions',
  QUOTA_EXCEEDED: 'quota_exceeded',
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
  /**
   * The host's catalogue or the caller's access to it changed. One event,
   * because every consumer recomputes the same derived value from both:
   * `LanguageModelInfo.access` folds access into each catalogue entry.
   */
  onDidChange(listener: () => void): Disposable;
}

/** Shared implementation for CLI, desktop, tests, and unsupported editors. */
export const UNAVAILABLE_LANGUAGE_MODEL_PORT: LanguageModelPort = Object.freeze(
  {
    isAvailable: () => false,
    selectModels: async () => [],
    onDidChange: () => ({ dispose() {} }),
  },
);

/**
 * The process's editor language-model bridge as an Effect service
 * (`@texra/platform/LanguageModel`), provided once by the composition root
 * through `installProcessRuntime`. The shape is the port itself — hosts
 * without an editor language-model API provide
 * {@link UNAVAILABLE_LANGUAGE_MODEL_PORT} — so a program that discovers
 * editor-supplied models yields the service instead of reading the platform
 * ambiently.
 *
 * `layer` takes the port itself, for the same reason `AppState.layer` takes
 * the store: every root builds its port before installing the runtime that
 * serves it.
 */
export class LanguageModel extends Context.Service<
  LanguageModel,
  LanguageModelPort
>()('@texra/platform/LanguageModel') {
  static layer(port: LanguageModelPort): Layer.Layer<LanguageModel> {
    return Layer.succeed(LanguageModel)(port);
  }
}
