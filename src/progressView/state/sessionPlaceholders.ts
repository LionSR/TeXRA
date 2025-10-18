export const MIGRATION_PLACEHOLDER_ID = '__MIGRATION__';
export const DEFAULT_PLACEHOLDER_ID = '__DEFAULT__';

export const SESSION_PLACEHOLDER_IDS = [
  MIGRATION_PLACEHOLDER_ID,
  DEFAULT_PLACEHOLDER_ID,
] as const;

export function isPlaceholderSessionId(
  groupId: string | null | undefined,
): groupId is typeof SESSION_PLACEHOLDER_IDS[number] {
  return groupId === MIGRATION_PLACEHOLDER_ID || groupId === DEFAULT_PLACEHOLDER_ID;
}
