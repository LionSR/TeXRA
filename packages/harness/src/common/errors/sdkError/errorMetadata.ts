import { Predicate } from 'effect';
import { ProviderErrorSchema, type ProviderError } from '@shared/schemas';

import { causeChain } from '../errorPredicates';

// `Symbol.for` keys, so every bundle that carries this module reads one mark.
const PRESENTATION_CLAIMED = Symbol.for('texra.errorPresentationClaimed');
const PROVIDER_ERROR = Symbol.for('texra.providerError');

const attach = (err: unknown, key: symbol, value: unknown): void => {
  if (Predicate.isObject(err)) (err as Record<symbol, unknown>)[key] = value;
};

const read = (err: unknown, key: symbol): unknown =>
  Predicate.isObject(err) ? (err as Record<symbol, unknown>)[key] : undefined;

/** Marks that a targeted, actionable notification owns this error's
 *  presentation, so a later generic handler on the same call stack does not
 *  show a second, redundant notification for the same failure. Attached in
 *  exactly two cases: the targeted emit reported confirmed delivery, or no
 *  host was attached at the throw site and the notification was retained for
 *  replay (the queued replay then either renders it or calls the
 *  caller-supplied not-delivered fallback). It is never attached for a
 *  fire-and-forget or declined emit, so a host that could not render the
 *  targeted notification still leaves the generic surface free to fire. */
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

const isProviderError = (value: unknown): value is ProviderError =>
  ProviderErrorSchema.safeParse(value).success;

/** The ProviderError cached on `err` itself, if a valid one is there. */
export const detectProviderError = (
  err: unknown,
): ProviderError | undefined => {
  const value = read(err, PROVIDER_ERROR);
  return isProviderError(value) ? value : undefined;
};
