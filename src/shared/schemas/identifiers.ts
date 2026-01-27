// Third-party imports
import { z } from 'zod';

/** Human-readable ID for UI tabs. Format: "${agentName}@${modelName}: ${inputFileName}" */
export const StreamTabIdSchema = z.string().min(1);
export type StreamTabId = z.infer<typeof StreamTabIdSchema>;

export const ExecutionIdSchema = z.uuid();
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;

const STORAGE_KEY_PATTERN =
  /^(__default__|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Valid storage key: UUID or '__default__' for legacy */
export const StorageKeySchema = z
  .string()
  .regex(
    STORAGE_KEY_PATTERN,
    'Invalid storage key: must be UUID or __default__',
  )
  .transform((val) => val as StorageKey);
export type StorageKey = string & { readonly __brand: 'StorageKey' };

