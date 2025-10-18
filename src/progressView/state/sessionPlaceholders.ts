export const MIGRATION_PLACEHOLDER_ID = '__MIGRATION__';
export const DEFAULT_PLACEHOLDER_ID = '__DEFAULT__';

/**
 * Placeholder identifiers appear in fallback order – prefer DEFAULT over
 * MIGRATION so we surface the data that was queued for the active session
 * before any legacy artifacts.
 */
export const SESSION_PLACEHOLDER_IDS = [
  DEFAULT_PLACEHOLDER_ID,
  MIGRATION_PLACEHOLDER_ID,
] as const;

export function isPlaceholderSessionId(
  groupId: string | null | undefined,
): groupId is (typeof SESSION_PLACEHOLDER_IDS)[number] {
  return (
    groupId === MIGRATION_PLACEHOLDER_ID || groupId === DEFAULT_PLACEHOLDER_ID
  );
}
