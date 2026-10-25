import { Predicate, Result, Schema } from 'effect';
import { ProviderErrorSchema, type ProviderError } from '@shared/schemas';

import { causeChain } from '@utils/errors/errorMessage';

// `Symbol.for` keys, so every bundle that carries this module reads one mark.
const PRESENTATION_CLAIMED = Symbol.for('texra.errorPresentationClaimed');
const PROVIDER_ERROR = Symbol.for('texra.providerError');

/** The marks of the objects that cannot take a property (frozen, sealed or
 *  otherwise non-extensible errors): assigning the symbol would throw. Unlike
 *  the symbol, this map is one per bundle that carries this module. */
const sideMarks = new WeakMap<object, Map<symbol, unknown>>();

const attach = (err: unknown, key: symbol, value: unknown): void => {
  if (!Predicate.isObject(err)) return;
  if (Object.isExtensible(err)) {
    // cast: a symbol-keyed slot on an extensible object.
    (err as Record<symbol, unknown>)[key] = value;
    return;
  }
  const marks = sideMarks.get(err) ?? new Map<symbol, unknown>();
  marks.set(key, value);
  sideMarks.set(err, marks);
};

const read = (err: unknown, key: symbol): unknown => {
  if (!Predicate.isObject(err)) return undefined;
  // cast: a symbol-keyed slot read; absent reads as undefined.
  const own = (err as Record<symbol, unknown>)[key];
  return own === undefined ? sideMarks.get(err)?.get(key) : own;
};

/** Marks that this failure was presented, so no later presenter (a generic
 *  handler on the same call stack, a host's own fallback) shows it again.
 *  Attached when a targeted notification owns its presentation (its emit
 *  confirmed delivery, or no host was attached and it was retained for
 *  replay), when the session's presenter showed a run's failure from its
 *  `run.end` row (`presentRunFailure`, `receiveTerminalFailure`), and when
 *  another process (a service) showed it to this window. Never for a
 *  fire-and-forget or declined emit, so a host that could not render a
 *  targeted notification leaves the generic surface free to fire. */
export const attachErrorPresentationClaimed = (err: unknown): void =>
  attach(err, PRESENTATION_CLAIMED, true);

/** Whether the claim is on `err` or anywhere in its rethrow chain, so a
 *  wrapper that preserves `{ cause }` stays classifiable. */
export const hasErrorPresentationClaimed = (err: unknown): boolean =>
  causeChain(err).some(
    (current) => read(current, PRESENTATION_CLAIMED) === true,
  );

/** Cache a structured ProviderError on any object so downstream error
 *  formatters can recover it without sniffing the message string. */
export const attachProviderError = (err: unknown, value: ProviderError): void =>
  attach(err, PROVIDER_ERROR, value);

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
  const value = read(err, PROVIDER_ERROR);
  return isProviderError(value) ? value : undefined;
};
