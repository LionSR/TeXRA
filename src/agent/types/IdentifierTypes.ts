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
export const ExecutionIdSchema = z.uuid();
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;

/** Valid storage key: UUID or '__default__' for legacy */
const STORAGE_KEY_PATTERN =
  /^(__default__|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const StorageKeySchema = z
  .string()
  .regex(
    STORAGE_KEY_PATTERN,
    'Invalid storage key: must be UUID or __default__',
  )
  .transform((val) => val as StorageKey);
export type StorageKey = string & { readonly __brand: 'StorageKey' };

/**
 * Unified identity for an execution - computed once, used everywhere.
 * - executionId: unique instance (for history, audit)
 * - storageKey: THE key for storage (files, usage, artifacts)
 * - streamTabId: UI tab identifier
 */
export const ExecutionIdentitySchema = z.strictObject({
  executionId: ExecutionIdSchema,
  storageKey: StorageKeySchema,
  streamTabId: StreamTabIdSchema,
});
export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;
