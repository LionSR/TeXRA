/** True for a value that merges field by field: a plain object, not an array. */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
      isMergeableObject(parentValue) && isMergeableObject(childValue)
        ? mergeInheritedAgentObject(parentValue, childValue)
        : childValue;
  }
  return merged as T;
}
