/**
 * Stream Tab ID: Human-readable identifier used for UI tabs and execution deduplication
 * Format: "${agentName}@${modelName}: ${inputFileName}"
 * Example: "polish@sonnet37: paper.tex"
 *
 * Purpose:
 * - Primary key for UI stream tabs
 * - Prevents duplicate executions of the same task
 * - Used for logging channel identification
 */
export type StreamTabId = string;

/**
 * Execution ID: Unique UUID for each execution instance
 * Format: UUID v4
 * Example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *
 * Purpose:
 * - Links executions to history entries
 * - Enables tracking of multiple executions of the same task
 * - Used for audit and debugging purposes
 */
export type ExecutionId = string;
