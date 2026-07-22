import { type ProviderError, type StreamDiagnostics } from '@shared/schemas';
import { isObject, isString } from '@utils/core';

import { findInCauseChain } from '../errorPredicates';
import { type SdkErrorMetadata, isSdkErrorMetadata } from './sdkErrorKinds';

/** Factory for symbol-keyed error metadata. Creates matched attach/detect
 *  accessors that share a single Symbol.for key. The optional typeGuard
 *  validates the value on retrieval; without it, raw retrieval is returned. */
function createErrorMetadata<T>(
  name: string,
  typeGuard?: (v: unknown) => v is T,
): {
  attach: (err: unknown, value: T) => void;
  detect: (err: unknown) => T | undefined;
} {
  const key = Symbol.for(`texra.${name}`);
  return {
    attach: (err, value) => {
      if (isObject(err)) {
        (err as Record<symbol, unknown>)[key] = value;
      }
    },
    detect: (err) => {
      if (!isObject(err)) return undefined;
      const value = (err as Record<symbol, unknown>)[key];
      if (typeGuard) {
        return typeGuard(value) ? value : undefined;
      }
      return value as T | undefined;
    },
  };
}

const sdkErrorMetadata = createErrorMetadata<SdkErrorMetadata>(
  'sdkError',
  isSdkErrorMetadata,
);

/** Tags SDK errors at provider boundaries so common error formatting does not
 *  need to import SDK classes or inspect SDK-specific prototypes. */
export const attachSdkErrorMetadata = sdkErrorMetadata.attach;
export const detectSdkErrorMetadata = sdkErrorMetadata.detect;

const streamDiagnosticsMetadata = createErrorMetadata<StreamDiagnostics>(
  'streamDiagnostics',
  (v): v is StreamDiagnostics => isObject(v) && 'eventsProcessed' in v,
);

/** Attaches stream diagnostics to an error before rethrowing. */
export const attachStreamDiagnostics = streamDiagnosticsMetadata.attach;
export const detectStreamDiagnostics = streamDiagnosticsMetadata.detect;

const partialTextMetadata = createErrorMetadata<string>(
  'partialText',
  (v): v is string => isString(v) && v.length > 0,
);

/** Attaches partial text (generated before a stream failure) to an error.
 *  Lets the caller surface the partial content to the user or use it as the
 *  basis for a continuation prompt on retry. No-op if the text is empty. */
export function attachPartialText(err: unknown, text: string): void {
  if (text) partialTextMetadata.attach(err, text);
}

export const detectPartialText = partialTextMetadata.detect;

const flowAutoRetryRequiredMetadata = createErrorMetadata<boolean>(
  'flowAutoRetryRequired',
  (v): v is boolean => v === true,
);

/**
 * Marks errors that are outside the provider SDK's automatic retry boundary.
 * Examples include failures while consuming an already-open stream or polling
 * an already-created background response.
 */
export function attachFlowAutoRetryRequired(err: unknown): void {
  flowAutoRetryRequiredMetadata.attach(err, true);
}

/** Match only a raw outer fetch failure. An SDK connection error may carry
 *  the same TypeError as its cause after adding provider-specific context. */
function isRawFetchFailure(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /^(?:fetch failed|failed to fetch)$/i.test(err.message.trim())
  );
}

export function requiresFlowAutoRetry(err: unknown): boolean {
  return (
    findInCauseChain(err, (current) =>
      flowAutoRetryRequiredMetadata.detect(current) === true ? true : undefined,
    ) !== undefined || isRawFetchFailure(err)
  );
}

const contextWindowErrorMetadata = createErrorMetadata<boolean>(
  'contextWindowError',
  (v): v is boolean => v === true,
);

/**
 * Marks an error as a TeXRA-internal context-window violation at the throw
 * site (e.g. `ModelHandler.validateTokenLimits`). Lets `isContextWindowError`
 * recognize the internal case without string-matching a message whose exact
 * wording the thrower owns — third-party provider error text is still
 * matched via `CONTEXT_WINDOW_PATTERNS`.
 */
export function attachContextWindowError(err: unknown): void {
  contextWindowErrorMetadata.attach(err, true);
}

export function hasContextWindowErrorMarker(err: unknown): boolean {
  return (
    findInCauseChain(err, (current) =>
      contextWindowErrorMetadata.detect(current) === true ? true : undefined,
    ) ?? false
  );
}

export const providerErrorMetadata =
  createErrorMetadata<ProviderError>('providerError');

/** Cache a structured ProviderError on any object so downstream error
 *  formatters can recover it without sniffing the message string. */
export const attachProviderError = providerErrorMetadata.attach;
