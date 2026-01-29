import { z } from 'zod';

/**
 * Schema for storage records with null/invalid fallback to empty object.
 *
 * Use this when loading records from storage that may be null, undefined,
 * or invalid (e.g., an array instead of object).
 *
 * @example
 * const data = StorageRecordSchema.parse(storage.get(key));
 * // Always returns Record<string, unknown>, never null/undefined
 */
export const StorageRecordSchema = z.record(z.string(), z.unknown()).catch({});

export type StorageRecord = z.infer<typeof StorageRecordSchema>;
