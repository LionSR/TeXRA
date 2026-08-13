// Third-party imports
import deepmerge from 'deepmerge';

/** Merge inherited agent config blocks with child arrays replacing parent arrays. */
export function mergeInheritedAgentObject<T extends object>(
  parent: T,
  child: object,
): T {
  return deepmerge(parent, child, {
    arrayMerge: (_destinationArray, sourceArray) => sourceArray,
  }) as T;
}
