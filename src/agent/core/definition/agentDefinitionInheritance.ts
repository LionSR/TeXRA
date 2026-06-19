// Third-party imports
import deepmerge from 'deepmerge';

function replaceArrays(
  _destinationArray: unknown[],
  sourceArray: unknown[],
): unknown[] {
  return sourceArray;
}

/** Merge inherited agent config blocks with child arrays replacing parent arrays. */
export function mergeInheritedAgentObject<T extends object>(
  parent: T,
  child: object,
): T {
  return deepmerge(parent, child, { arrayMerge: replaceArrays }) as T;
}
