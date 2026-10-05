import { ProviderErrorSchema, type ProviderError } from '@shared/schemas';
import { isObject } from '@utils/core';

import { causeChain } from '../errorPredicates';

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
 * Marks an error as a context-window overflow where it is classified
 * (`run/modelFailure.ts` from the llm package's `context-overflow` verdict,
 * `AgentRunLifecycle.ts`), so later readers recognize it without reading
 * any message.
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
