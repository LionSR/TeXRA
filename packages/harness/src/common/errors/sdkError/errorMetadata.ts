import { Predicate, Result, Schema } from 'effect';
import { ProviderErrorSchema, type ProviderError } from '@shared/schemas';

// A `Symbol.for` key, so every bundle that carries this module reads one mark.
const PROVIDER_ERROR = Symbol.for('texra.providerError');

/** The marks of the objects that cannot take a property (frozen, sealed or
 *  otherwise non-extensible errors): assigning the symbol would throw. Unlike
 *  the symbol, this map is one per bundle that carries this module. */
const sideMarks = new WeakMap<object, ProviderError>();

/** Cache a structured ProviderError on any object so downstream error
 *  formatters can recover it without sniffing the message string. */
export const attachProviderError = (
  err: unknown,
  value: ProviderError,
): void => {
  if (!Predicate.isObject(err)) return;
  if (!Object.isExtensible(err)) {
    sideMarks.set(err, value);
    return;
  }
  // cast: a symbol-keyed slot on an extensible object.
  (err as Record<symbol, unknown>)[PROVIDER_ERROR] = value;
};

/** Unknown fields are rejected, so a legacy or mixed record never enters the
 *  runtime metadata cache. */
const isProviderError = (value: unknown): value is ProviderError =>
  Result.isSuccess(
    Schema.decodeUnknownResult(ProviderErrorSchema, {
      onExcessProperty: 'error',
    })(value),
  );

/** The ProviderError cached on `err` itself, if a valid one is there. */
export const detectProviderError = (
  err: unknown,
): ProviderError | undefined => {
  if (!Predicate.isObject(err)) return undefined;
  // cast: a symbol-keyed slot read; absent reads as undefined.
  const own = (err as Record<symbol, unknown>)[PROVIDER_ERROR];
  const value = own === undefined ? sideMarks.get(err) : own;
  return isProviderError(value) ? value : undefined;
};
