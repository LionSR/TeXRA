/**
 * # Identifier Types and Execution Model
 *
 * TeXRA uses three distinct identifier types to track executions:
 *
 * ## Hierarchy
 * ```
 * StreamTabId (UI tab)
 *   └── ExecutionId (history entry, UUID)
 *         └── RunId (task group for files/usage, UUID or DEFAULT_RUN_ID)
 * ```
 *
 * ## Workflow Agents (multi-round agents with task groups)
 * - Create task groups via the logger hierarchy
 * - RunId = task group ID from logger (a UUID)
 * - Files and usage are stored under the task group's RunId
 *
 * ## Tool-Use Agents (interactive, single-session agents)
 * - Do NOT create task groups (no logger hierarchy)
 * - RunId = ExecutionId (they are the same value)
 * - Files and usage are stored under the ExecutionId as the RunId
 *
 * ## Key Invariants
 * - ExecutionId is ALWAYS a UUID (never null, never DEFAULT_RUN_ID)
 * - RunId can be a UUID (task group or execution) OR DEFAULT_RUN_ID (legacy)
 * - StreamTabId is human-readable and stable across executions
 */

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
 * - Links executions to history entries (created by AgentHistoryManager)
 * - Enables tracking of multiple executions of the same task
 * - For tool-use agents, also serves as the RunId
 * - Used for audit and debugging purposes
 *
 * Note: ExecutionId is ALWAYS a UUID, never null or DEFAULT_RUN_ID.
 */
export type ExecutionId = string;

/**
 * Run ID: Identifier for grouping files and usage statistics
 * Format: UUID v4 OR DEFAULT_RUN_ID ("__default__")
 *
 * Purpose:
 * - Primary dimension key for output files in progress view
 * - Primary dimension key for usage statistics
 * - Groups related outputs within a single execution
 *
 * For workflow agents: This is the task group ID from the logger hierarchy.
 * For tool-use agents: This equals the ExecutionId (no task groups).
 * For legacy sessions: This is DEFAULT_RUN_ID ("__default__").
 *
 * Note: When storing/retrieving data, use normalizeRunId() only for
 * workflow agents or legacy data. Tool-use agents should use their
 * ExecutionId directly without normalization.
 */
export type RunId = string;
