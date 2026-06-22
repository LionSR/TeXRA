import { type ProviderError, type StreamDiagnostics } from '@shared/schemas';
import { isObject, isString } from '@utils/core';

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

export const providerErrorMetadata =
  createErrorMetadata<ProviderError>('providerError');

/** Cache a structured ProviderError on any object so downstream error
 *  formatters can recover it without sniffing the message string. */
export const attachProviderError = providerErrorMetadata.attach;
export const detectProviderError = providerErrorMetadata.detect;

const loggedErrorMetadata = createErrorMetadata<true>('errorLogged');

/** Mark an error as already logged so duplicate trace rows are skipped. */
export function markErrorLogged(err: unknown): void {
  loggedErrorMetadata.attach(err, true);
}

/** Check whether an error has already been logged to the trace. */
export function isErrorLogged(err: unknown): boolean {
  return loggedErrorMetadata.detect(err) === true;
}
