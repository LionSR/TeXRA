import { z } from 'zod';

export const StreamTabIdSchema = z.string().min(1);
export type StreamTabId = z.infer<typeof StreamTabIdSchema>;

/** Hex string (12-char current, 6-char and UUID-like legacy forms). */
export const ExecutionIdSchema = z
  .string()
  .min(6)
  .regex(/^[0-9a-f][-0-9a-f]*$/i, 'Invalid execution ID: expected hex');
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;

/** Execution ID or the __default__ sentinel for legacy storage. */
export type StorageKey = string & { readonly __brand: 'StorageKey' };
