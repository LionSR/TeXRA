import { isObject } from '@utils/core';

/** Merge inherited agent config blocks with child arrays replacing parent arrays. */
export function mergeInheritedAgentObject<T extends object>(
  parent: T,
  child: object,
): T {
  const merged: Record<string, unknown> = {
    ...(parent as Record<string, unknown>),
  };
  for (const [key, childValue] of Object.entries(child)) {
    const parentValue = merged[key];
    merged[key] =
      isObject(parentValue) && isObject(childValue)
        ? mergeInheritedAgentObject(parentValue, childValue)
        : childValue;
  }
  return merged as T;
}
