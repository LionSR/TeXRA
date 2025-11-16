/**
 * Stream Tab ID: Human-readable identifier used for UI tabs and execution deduplication
 * Format: "${agentName}@${modelName}: ${inputFileName}"
 * Example: "polish@sonnet37: paper.tex"
 *
 * Purpose:
 * - Primary key for UI stream tabs
 * - Prevents duplicate executions of the same task
 * - Used for logging channel identification
 *
 * This is a branded type to prevent accidental use of plain strings as IDs.
 */
export type StreamTabId = string & { readonly __brand: 'StreamTabId' };

/**
 * Execution ID: Unique UUID for each execution instance
 * Format: UUID v4
 * Example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *
 * Purpose:
 * - Links executions to history entries
 * - Enables tracking of multiple executions of the same task
 * - Used for audit and debugging purposes
 *
 * This is a branded type to prevent accidental use of plain strings as IDs.
 */
export type ExecutionId = string & { readonly __brand: 'ExecutionId' };

/**
 * Creates a StreamTabId from a string.
 * Use this function to create StreamTabIds to ensure type safety.
 *
 * @param agentName The agent name
 * @param modelName The model name
 * @param inputFileName The input file name
 * @returns A properly formatted StreamTabId
 */
export function createStreamTabId(
  agentName: string,
  modelName: string,
  inputFileName: string,
): StreamTabId {
  return `${agentName}@${modelName}: ${inputFileName}` as StreamTabId;
}

/**
 * Creates a StreamTabId from a raw string.
 * Use with caution - prefer createStreamTabId when possible.
 *
 * @param id The raw string ID
 * @returns A StreamTabId
 */
export function asStreamTabId(id: string): StreamTabId {
  return id as StreamTabId;
}

/**
 * Creates an ExecutionId from a UUID string.
 * Use this function to create ExecutionIds to ensure type safety.
 *
 * @param uuid A UUID v4 string
 * @returns An ExecutionId
 */
export function asExecutionId(uuid: string): ExecutionId {
  return uuid as ExecutionId;
}

/**
 * Type guard to check if a string is a valid ExecutionId format (UUID v4)
 */
export function isValidExecutionId(id: string): id is ExecutionId {
  const uuidV4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(id);
}
