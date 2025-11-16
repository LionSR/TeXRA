/**
 * Utility functions for merging objects safely.
 * Provides type-safe alternatives to Object.assign for common merge patterns.
 */

/**
 * Merges multiple source objects into a target object.
 * Provides better type safety than repeated Object.assign calls.
 *
 * @param target The target object to merge into
 * @param sources Variable number of source objects to merge
 * @returns The merged target object
 *
 * @example
 * const result = mergeObjects({}, source1, source2, source3);
 */
export function mergeObjects<T extends Record<string, unknown>>(
  target: T,
  ...sources: Array<Record<string, unknown> | null | undefined>
): T {
  for (const source of sources) {
    if (source) {
      Object.assign(target, source);
    }
  }
  return target;
}

/**
 * Merges multiple source objects into a new object without mutating inputs.
 *
 * @param sources Variable number of source objects to merge
 * @returns A new merged object
 *
 * @example
 * const result = mergeNew(source1, source2, source3);
 */
export function mergeNew<T extends Record<string, unknown>>(
  ...sources: Array<Record<string, unknown> | null | undefined>
): T {
  return mergeObjects({} as T, ...sources);
}
