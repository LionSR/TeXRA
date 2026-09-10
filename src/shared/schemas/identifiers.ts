import { z } from 'zod';

export const StreamTabIdSchema = z.string().min(1);
export type StreamTabId = z.infer<typeof StreamTabIdSchema>;

/** A stream tab id, or the empty-string sentinel meaning "no active stream". */
export const RunSelectionSchema = z.union([StreamTabIdSchema, z.literal('')]);

/** Hex string (12-char current, 6-char and UUID-like legacy forms). */
export const RunIdSchema = z
  .string()
  .min(6)
  .regex(/^[0-9a-f][-0-9a-f]*$/i, 'Invalid execution ID: expected hex');
export type RunId = z.infer<typeof RunIdSchema>;
