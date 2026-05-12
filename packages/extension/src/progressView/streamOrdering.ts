import type { StreamTabInfo } from '@shared/schemas';

export function compareByNewestCreationTime(
  a: StreamTabInfo,
  b: StreamTabInfo,
): number {
  return (
    b.creationTimestamp - a.creationTimestamp || a.name.localeCompare(b.name)
  );
}
