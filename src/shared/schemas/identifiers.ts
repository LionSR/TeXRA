import { z } from 'zod';

export const StreamTabIdSchema = z.string().min(1);
export type StreamTabId = z.infer<typeof StreamTabIdSchema>;

/** Compact 12-char hex ID (new format) or legacy 36-char UUID. */
const EXECUTION_ID_PATTERN =
  /^([0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const ExecutionIdSchema = z
  .string()
  .regex(EXECUTION_ID_PATTERN, 'Invalid execution ID: expected 12-char hex or UUID');
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;

/** Accepts execution IDs (compact or legacy UUID) and the __default__ sentinel. */
const STORAGE_KEY_PATTERN =
  /^(__default__|[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const StorageKeySchema = z
  .string()
  .regex(
    STORAGE_KEY_PATTERN,
    'Invalid storage key: must be execution ID, UUID, or __default__',
  )
  .transform((val) => val as StorageKey);
export type StorageKey = string & { readonly __brand: 'StorageKey' };
