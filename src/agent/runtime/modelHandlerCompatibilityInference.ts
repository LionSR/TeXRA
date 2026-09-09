import { isObject } from '@utils/core';

import {
  ModelHandlerCompatibilityKeySchema,
  type ModelHandlerCompatibilityKey,
} from './modelHandlerCompatibilityKey';

/**
 * The compatibility key a persisted flow record carries. Records are stamped
 * at write time, so a record without one is malformed rather than old.
 */
export function persistedFlowModelHandlerCompatibilityKey(
  shared: unknown,
): ModelHandlerCompatibilityKey | undefined {
  if (!isObject(shared)) return undefined;
  const parsed = ModelHandlerCompatibilityKeySchema.nullish().safeParse(
    shared.modelHandlerCompatibilityKey,
  );
  return parsed.success ? (parsed.data ?? undefined) : undefined;
}
