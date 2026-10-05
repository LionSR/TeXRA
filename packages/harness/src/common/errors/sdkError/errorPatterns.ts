import { isObject } from '@utils/core';

import { getErrorClassNames } from './errorInspection';

/** True if `err` is an SDK or AbortController user-abort error. */
export function isUserAbort(err: unknown): boolean {
  if (getErrorClassNames(err).includes('APIUserAbortError')) return true;
  return isObject(err) && err.name === 'AbortError';
}
