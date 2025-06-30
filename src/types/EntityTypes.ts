/**
 * Simple typed UUID identifiers for stream entities.
 *
 * These are just string types with meaningful names for clarity and type safety.
 * All IDs are UUID v4 format generated when entities are added to streams.
 */

/**
 * Task Group ID - identifies a specific task group/section in logs
 * Used for updating group status, end time, usage stats
 */
export type TaskGroupId = string;

/**
 * Log Message ID - identifies a specific log message entry
 * Used for updating message content, type, verbose flag
 */
export type LogMessageId = string;
