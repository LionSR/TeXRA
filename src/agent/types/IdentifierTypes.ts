/**
 * # Identifier Types and Execution Model
 *
 * TeXRA uses a unified identity model to track executions, eliminating
 * confusion about which ID to use for storage and lookup.
 *
 * ## Identity Hierarchy
 * ```
 * StreamTabId (UI tab, human-readable)
 *   └── ExecutionIdentity
 *         ├── executionId (unique instance, always UUID)
 *         └── storageKey (THE key for files/usage storage)
 * ```
 *
 * ## Single Source of Truth: StorageKey
 *
 * The storageKey is computed ONCE at execution start and used everywhere:
 * - Workflow agents: storageKey = task group ID (set when group is created)
 * - Tool-use agents: storageKey = executionId (no task groups)
 *
 * This eliminates:
 * - Runtime ID resolution at every call site
 * - Dual-lookup paths in storage managers
 * - "Which ID do I use?" confusion
 *
 * ## Key Invariants
 * - ExecutionId is ALWAYS a UUID (never null, never DEFAULT_RUN_ID)
 * - StorageKey is ALWAYS a valid key (UUID or DEFAULT_RUN_ID for legacy)
 * - StreamTabId is human-readable and stable across executions
 *
 * @see ExecutionIdentity for the unified identity interface
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
 * - Used for audit and debugging purposes
 *
 * Note: ExecutionId is ALWAYS a UUID, never null or DEFAULT_RUN_ID.
 */
export type ExecutionId = string;

/**
 * Storage Key: THE key for storing and retrieving files, usage, and other artifacts.
 *
 * This is the single source of truth for storage operations:
 * - Workflow agents: This is the task group ID from the logger hierarchy
 * - Tool-use agents: This equals the ExecutionId (no task groups)
 * - Legacy sessions: This is DEFAULT_RUN_ID ("__default__")
 *
 * The storageKey is computed ONCE at execution start (or when a task group
 * is created for workflow agents) and never changes during execution.
 *
 * Use ExecutionIdentity.storageKey to get this value - never compute it manually.
 *
 * This is a branded type for compile-time safety - you cannot accidentally
 * pass a random string where a StorageKey is expected.
 */
export type StorageKey = string & { readonly __brand: 'StorageKey' };

/**
 * Run ID: Legacy identifier for grouping files and usage statistics.
 *
 * @deprecated Use StorageKey and ExecutionIdentity instead.
 * This type is kept for backward compatibility with existing code.
 * New code should use ExecutionIdentity.storageKey.
 *
 * For workflow agents: This is the task group ID from the logger hierarchy.
 * For tool-use agents: This equals the ExecutionId (no task groups).
 * For legacy sessions: This is DEFAULT_RUN_ID ("__default__").
 */
export type RunId = string;

/**
 * Unified identity for an execution - computed once, used everywhere.
 *
 * This interface eliminates "which ID should I use?" confusion by providing:
 * - executionId: The unique execution instance (for history, audit, metadata)
 * - storageKey: THE key for storage operations (files, usage, artifacts)
 * - streamTabId: The UI tab identifier
 *
 * ## Usage
 *
 * Components receive ExecutionIdentity in their constructor or method parameters
 * instead of computing IDs themselves:
 *
 * ```typescript
 * class OutputHandler {
 *   constructor(private readonly identity: ExecutionIdentity) {}
 *
 *   emit(files: OutputFileInfo[]): void {
 *     bus.emit('addOutputFiles', {
 *       stream: this.identity.streamTabId,
 *       storageKey: this.identity.storageKey,  // THE key
 *       executionId: this.identity.executionId, // For metadata
 *       files,
 *     });
 *   }
 * }
 * ```
 *
 * ## Workflow vs Tool-Use
 *
 * - Workflow agents call `updateStorageKey()` when they create their first
 *   task group, setting storageKey to the task group ID
 * - Tool-use agents use executionId as storageKey (no task groups exist)
 */
export interface ExecutionIdentity {
  /** The unique execution instance ID (always UUID) */
  readonly executionId: ExecutionId;

  /** THE key for storage operations (files, usage, artifacts) */
  readonly storageKey: StorageKey;

  /** The UI tab identifier */
  readonly streamTabId: StreamTabId;
}
