/**
 * Identifier Types and Execution Model
 *
 * Identity hierarchy:
 *   StreamTabId (UI tab, human-readable)
 *     └── ExecutionIdentity
 *           ├── executionId (unique instance, always UUID)
 *           └── storageKey (THE key for files/usage storage)
 *
 * Key invariants:
 * - ExecutionId is ALWAYS a UUID (never null, never DEFAULT_RUN_ID)
 * - StorageKey is ALWAYS a valid key (UUID or DEFAULT_RUN_ID for legacy)
 * - StreamTabId is human-readable and stable across executions
 */
import { z } from 'zod';

/** Human-readable ID for UI tabs. Format: "${agentName}@${modelName}: ${inputFileName}" */
export const StreamTabIdSchema = z.string().min(1);
export type StreamTabId = z.infer<typeof StreamTabIdSchema>;

/** Unique UUID for each execution instance */
export const ExecutionIdSchema = z.string().uuid();
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;

/** THE key for storage operations. Branded type for compile-time safety. */
export const StorageKeySchema = z
  .string()
  .min(1)
  .transform((val) => val as StorageKey);
export type StorageKey = string & { readonly __brand: 'StorageKey' };

/**
 * Unified identity for an execution - computed once, used everywhere.
 * - executionId: unique instance (for history, audit)
 * - storageKey: THE key for storage (files, usage, artifacts)
 * - streamTabId: UI tab identifier
 */
export interface ExecutionIdentity {
  readonly executionId: ExecutionId;
  readonly storageKey: StorageKey;
  readonly streamTabId: StreamTabId;
}

export const ExecutionIdentitySchema = z.strictObject({
  executionId: ExecutionIdSchema,
  storageKey: StorageKeySchema,
  streamTabId: StreamTabIdSchema,
});
