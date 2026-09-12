import {
  ProviderErrorSchema,
  type ProviderError,
  type StreamDiagnostics,
} from '@shared/schemas';
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

/** Reads the SDK error metadata a provider boundary tagged, so common error
 *  formatting does not import SDK classes or inspect SDK-specific prototypes. */
export const detectSdkErrorMetadata = sdkErrorMetadata.detect;

const streamDiagnosticsMetadata = createErrorMetadata<StreamDiagnostics>(
  'streamDiagnostics',
  (v): v is StreamDiagnostics => isObject(v) && 'eventsProcessed' in v,
);

export const detectStreamDiagnostics = streamDiagnosticsMetadata.detect;

const partialTextMetadata = createErrorMetadata<string>(
  'partialText',
  (v): v is string => isString(v) && v.length > 0,
);

/** Partial text generated before a stream failure, when the thrower kept it. */
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
 * site (`run/modelFailure.ts`, `AgentRunLifecycle.ts`). Lets `isContextWindowError`
 * recognize the internal case without string-matching a message whose exact
 * wording the thrower owns — third-party provider error text is still
 * matched via `CONTEXT_WINDOW_PATTERNS`.
 */
export const attachContextWindowError = contextWindowErrorMarker.attach;
export const hasContextWindowErrorMarker = contextWindowErrorMarker.has;

const missingApiKeyErrorMarker = createErrorMarker('missingApiKeyError');

/** Marks "no usable credential for this provider" at its throw site,
 *  `resolveRouteCredential` in `runtime/modelRoutes.ts`. `classifyAgentError`
 *  reads this instead of matching the per-provider wording that function owns; the cause-chain
 *  lookup keeps it reachable through any later rethrow. */
export const attachMissingApiKeyError = missingApiKeyErrorMarker.attach;
export const hasMissingApiKeyErrorMarker = missingApiKeyErrorMarker.has;

const manualRetryOnlyErrorMarker = createErrorMarker('manualRetryOnlyError');

/** A user-retryable failure that must not repeat automatically. */
export const hasManualRetryOnlyErrorMarker = manualRetryOnlyErrorMarker.has;

const errorPresentationClaimedMarker = createErrorMarker(
  'errorPresentationClaimed',
);

/** Marks that a targeted, actionable notification owns this error's
 *  presentation, so a later generic handler on the same call stack does not
 *  show a second, redundant notification for the same failure. Attached in
 *  exactly two cases: the targeted emit reported confirmed delivery, or no
 *  host was attached at the throw site and the notification was retained for
 *  replay (the queued replay then either renders it or calls the
 *  caller-supplied not-delivered fallback). It is never attached for a
 *  fire-and-forget or declined emit, so a host that could not render the
 *  targeted notification still leaves the generic surface free to fire. */
export const attachErrorPresentationClaimed =
  errorPresentationClaimedMarker.attach;
export const hasErrorPresentationClaimed = errorPresentationClaimedMarker.has;

export const providerErrorMetadata = createErrorMetadata<ProviderError>(
  'providerError',
  (value): value is ProviderError =>
    ProviderErrorSchema.safeParse(value).success,
);

/** Cache a structured ProviderError on any object so downstream error
 *  formatters can recover it without sniffing the message string. */
export const attachProviderError = providerErrorMetadata.attach;
