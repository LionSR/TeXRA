import { Predicate } from 'effect';

/** True if `err` is an `AbortController` abort (a DOM `AbortError`). */
export function isUserAbort(err: unknown): boolean {
  return Predicate.isObject(err) && err.name === 'AbortError';
}
