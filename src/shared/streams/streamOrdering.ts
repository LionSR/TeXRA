import type { StreamTabInfo } from '@shared/schemas';

/** Sort by newest creation time first, breaking ties alphabetically by name. */
export function compareByNewestCreationTime(
  a: StreamTabInfo,
  b: StreamTabInfo,
): number {
  return (
    b.creationTimestamp - a.creationTimestamp || a.name.localeCompare(b.name)
  );
}
