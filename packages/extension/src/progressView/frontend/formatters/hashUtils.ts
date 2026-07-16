/**
 * Simple string hash for generating stable content-based IDs.
 * Used by createContentStore for content-addressable registries.
 */
export function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}
