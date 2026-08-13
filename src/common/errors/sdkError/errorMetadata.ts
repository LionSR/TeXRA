import { type ProviderError, type StreamDiagnostics } from '@shared/schemas';
import { isObject, isString } from '@utils/core';

import { causeChain } from '../errorPredicates';
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

/** Presence-only marker: attached at a throw site, detected anywhere in the
 *  rethrow chain so a wrapper that preserves `{ cause }` stays classifiable. */
function createErrorMarker(name: string): {
  attach: (err: unknown) => void;
  has: (err: unknown) => boolean;
} {
  const metadata = createErrorMetadata<boolean>(
    name,
    (v): v is boolean => v === true,
  );
  return {
    attach: (err) => metadata.attach(err, true),
    has: (err) =>
      causeChain(err).some((current) => metadata.detect(current) === true),
  };
}

const contextWindowErrorMarker = createErrorMarker('contextWindowError');

/**
 * Marks an error as a TeXRA-internal context-window violation at the throw
 * site (e.g. `ModelHandler.validateTokenLimits`). Lets `isContextWindowError`
 * recognize the internal case without string-matching a message whose exact
 * wording the thrower owns — third-party provider error text is still
 * matched via `CONTEXT_WINDOW_PATTERNS`.
 */
export const attachContextWindowError = contextWindowErrorMarker.attach;
export const hasContextWindowErrorMarker = contextWindowErrorMarker.has;

const missingApiKeyErrorMarker = createErrorMarker('missingApiKeyError');

/** Marks "no usable credential for this provider" at its one throw site,
 *  `ModelHandler.fetchApiKeyOrThrow`. `classifyAgentError` reads this instead
 *  of matching the per-provider wording that method owns; the cause-chain
 *  lookup keeps it reachable through any later rethrow. */
export const attachMissingApiKeyError = missingApiKeyErrorMarker.attach;
export const hasMissingApiKeyErrorMarker = missingApiKeyErrorMarker.has;

const manualRetryOnlyErrorMarker = createErrorMarker('manualRetryOnlyError');

/** Marks a user-retryable failure that must not repeat automatically. */
export const attachManualRetryOnlyError = manualRetryOnlyErrorMarker.attach;
export const hasManualRetryOnlyErrorMarker = manualRetryOnlyErrorMarker.has;

const errorPresentedMarker = createErrorMarker('errorPresented');

/** Marks an error as already shown to the user at a targeted throw site
 *  (e.g. agent-not-found, model-not-recognized), so a later generic handler
 *  on the same call stack does not show a second, redundant notification for
 *  the same failure. */
export const attachErrorPresented = errorPresentedMarker.attach;
export const hasErrorPresentedMarker = errorPresentedMarker.has;

export const providerErrorMetadata =
  createErrorMetadata<ProviderError>('providerError');

/** Cache a structured ProviderError on any object so downstream error
 *  formatters can recover it without sniffing the message string. */
export const attachProviderError = providerErrorMetadata.attach;
