import type { StreamTabInfo } from '@shared/schemas';

/** The two fields tab order depends on, so name-only sorts can reuse this rule. */
type StreamOrderingFields = Pick<StreamTabInfo, 'name' | 'creationTimestamp'>;

/** Sort by newest creation time first, breaking ties alphabetically by name. */
export function compareByNewestCreationTime(
  a: StreamOrderingFields,
  b: StreamOrderingFields,
): number {
  return (
    b.creationTimestamp - a.creationTimestamp || a.name.localeCompare(b.name)
  );
}
