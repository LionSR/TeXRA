// Third-party imports
import { z } from 'zod';

/**
 * Coerces and validates integer round keys from string record keys.
 */
export const RoundKeySchema = z.coerce.number().int();

/**
 * Factory for creating round map schemas that transform { roundNum: items[] } to Map<number, T[]>.
 * Filters out invalid round keys and empty item arrays.
 *
 * @param itemSchema - Zod schema for individual items in the round array
 */
export function createRoundMapSchema<T>(
  itemSchema: z.ZodType<T>,
): z.ZodType<Map<number, T[]>> {
  return z
    .record(z.string(), z.array(itemSchema).catch([]))
    .transform((record): Map<number, T[]> => {
      const map = new Map<number, T[]>();
      for (const [key, items] of Object.entries(record)) {
        const round = RoundKeySchema.safeParse(key);
        if (round.success && items.length > 0) {
          map.set(round.data, items);
        }
      }
      return map;
    }) as z.ZodType<Map<number, T[]>>;
}

/**
 * Factory for creating run map schemas.
 * Format: { runId: { roundNum: items[] } }
 *
 * @param roundMapSchema - Schema for parsing the inner round map structure
 */
export function createRunMapSchema<T>(
  roundMapSchema: z.ZodType<Map<number, T[]>>,
): z.ZodType<Map<string, Map<number, T[]>>> {
  return z.unknown().transform((data): Map<string, Map<number, T[]>> => {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const record = data as Record<string, unknown>;
    const runMap = new Map<string, Map<number, T[]>>();

    for (const [runId, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object') continue;
      const result = roundMapSchema.safeParse(value);
      if (result.success && result.data.size > 0) {
        runMap.set(runId, result.data);
      }
    }
    return runMap;
  }) as z.ZodType<Map<string, Map<number, T[]>>>;
}

/**
 * Factory for creating run map schemas for single-value items (not arrays per round).
 * Format: { runId: { field: value } }
 *
 * @param itemSchema - Schema for parsing individual item values
 * @param options.isEmpty - Optional predicate to skip empty/zero values
 */
export function createSingleValueRunMapSchema<T>(
  itemSchema: z.ZodType<T>,
  options?: { isEmpty?: (item: T) => boolean },
): z.ZodType<Map<string, T>> {
  const isEmpty = options?.isEmpty;

  return z.unknown().transform((data): Map<string, T> => {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const record = data as Record<string, unknown>;
    const runMap = new Map<string, T>();

    for (const [runId, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object') continue;
      const result = itemSchema.safeParse(value);
      if (result.success) {
        if (isEmpty?.(result.data)) continue;
        runMap.set(runId, result.data);
      }
    }
    return runMap;
  }) as z.ZodType<Map<string, T>>;
}
