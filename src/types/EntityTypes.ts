/**
 * Core entity types with UUID identifiers for proper referencing and updating.
 * 
 * This file defines strongly-typed UUID identifiers for all major entities
 * in the system, enabling proper referential integrity and safe updates.
 */

/**
 * Base UUID type for all entities
 */
export type EntityId = string;

/**
 * Task Group UUID - identifies a specific task group/section in logs
 * Format: UUID v4
 * Example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 * 
 * Purpose:
 * - Unique identifier for each task group
 * - Enables updating group status, end time, usage stats
 * - Supports nested group relationships via parentGroupId
 */
export type TaskGroupId = EntityId;

/**
 * Log Message UUID - identifies a specific log message entry
 * Format: UUID v4
 * Example: "b2c3d4e5-f6g7-8901-bcde-f23456789012"
 * 
 * Purpose:
 * - Unique identifier for each log message
 * - Enables updating message content, type, verbose flag
 * - Supports message association with groups
 */
export type LogMessageId = EntityId;

/**
 * Task State UUID - identifies a specific task state configuration
 * Format: UUID v4
 * Example: "c3d4e5f6-g7h8-9012-cdef-345678901234"
 * 
 * Purpose:
 * - Unique identifier for each task state
 * - Enables updating task configuration
 * - Supports task state versioning and history
 */
export type TaskStateId = EntityId;

/**
 * Output File UUID - identifies a specific output file entry
 * Format: UUID v4
 * Example: "d4e5f6g7-h8i9-0123-def4-456789012345"
 * 
 * Purpose:
 * - Unique identifier for each output file
 * - Enables updating file status, diff stats, metadata
 * - Supports file relationship tracking
 */
export type OutputFileId = EntityId;

/**
 * Agent Configuration UUID - identifies a specific agent config instance
 * Format: UUID v4
 * Example: "e5f6g7h8-i9j0-1234-ef56-567890123456"
 * 
 * Purpose:
 * - Unique identifier for each agent configuration
 * - Enables config versioning and comparison
 * - Supports config template management
 */
export type AgentConfigId = EntityId;

/**
 * Stream Session UUID - identifies a specific stream session
 * Format: UUID v4
 * Example: "f6g7h8i9-j0k1-2345-fg67-678901234567"
 * 
 * Purpose:
 * - Unique identifier for each stream session
 * - Enables session management and cleanup
 * - Supports multiple concurrent sessions for same streamTabId
 */
export type StreamSessionId = EntityId;

/**
 * Utility type for entities that require UUID identification
 */
export interface WithEntityId<T extends EntityId = EntityId> {
  /** Unique identifier for this entity */
  id: T;
}

/**
 * Utility type for entities that can be created without an ID (auto-generated)
 */
export type CreatableEntity<T> = T extends WithEntityId<infer U> 
  ? Omit<T, 'id'> & { id?: U }
  : T;

/**
 * Utility type for entities that can be updated (partial fields except ID)
 */
export type UpdatableEntity<T> = T extends WithEntityId<infer U>
  ? { id: U } & Partial<Omit<T, 'id'>>
  : Partial<T>;

/**
 * Type guard to check if an object has an entity ID
 */
export function hasEntityId<T extends EntityId>(
  obj: any
): obj is WithEntityId<T> {
  return obj && typeof obj.id === 'string' && obj.id.length > 0;
}

/**
 * Generate a new entity ID
 */
export function generateEntityId<T extends EntityId = EntityId>(): T {
  return crypto.randomUUID() as T;
}