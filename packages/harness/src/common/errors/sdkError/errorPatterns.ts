import { Predicate } from 'effect';
import { getErrorClassNames } from './errorInspection';

/** True if `err` is an SDK or AbortController user-abort error. */
export function isUserAbort(err: unknown): boolean {
  if (getErrorClassNames(err).includes('APIUserAbortError')) return true;
  return Predicate.isObject(err) && err.name === 'AbortError';
}
