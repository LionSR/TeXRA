import { Predicate } from 'effect';

import { causeChain } from '@utils/errors/errorMessage';

/** Check if an error is "dynamic import couldn't find the module" (Node + ESM variants). */
export function isModuleNotFoundError(err: unknown): boolean {
  return (
    Predicate.hasProperty(err, 'code') &&
    (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')
  );
}

/** Walks `err` and its `cause` chain, returning the first defined result of
 *  `extract`, or `undefined` if none of the nodes match. */
export function findInCauseChain<T>(
  err: unknown,
  extract: (node: unknown) => T | undefined,
): T | undefined {
  for (const current of causeChain(err)) {
    const result = extract(current);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** Check if an error represents a "no space left on device" condition. */
export function isDiskFullError(err: unknown): boolean {
  return causeChain(err).some(
    (current) =>
      Predicate.hasProperty(current, 'code') && current.code === 'ENOSPC',
  );
}

/** True if `err` is an `AbortController` abort (a DOM `AbortError`). */
export function isUserAbort(err: unknown): boolean {
  return Predicate.isObject(err) && err.name === 'AbortError';
}
