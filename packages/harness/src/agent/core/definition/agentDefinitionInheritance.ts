import { Predicate } from 'effect';

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
      Predicate.isObject(parentValue) && Predicate.isObject(childValue)
        ? mergeInheritedAgentObject(parentValue, childValue)
        : childValue;
  }
  return merged as T;
}
