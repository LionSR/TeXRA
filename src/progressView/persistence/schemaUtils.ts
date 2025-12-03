// Third-party imports
import { z } from 'zod';

// Local imports
import { normalizeRunId } from '@common/constants/runIds';

/**
 * Coerces and validates integer round keys from string record keys.
 */
export const RoundKeySchema = z.coerce.number().int();

/**
 * Detects if a record uses legacy numeric-keyed format.
 * Legacy format: { "0": [...], "1": [...] } - round numbers as keys
 * Modern format: { "runId123": { "0": [...] } } - run IDs as keys
 */
export function isLegacyNumericKeyFormat(
  record: Record<string, unknown>,
): boolean {
  const entries = Object.entries(record);
  return (
    entries.length > 0 &&
    entries.every(([key]) => !Number.isNaN(Number.parseInt(key, 10)))
  );
}

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
 * Factory for creating schemas that handle both legacy flat format and modern run map format.
 *
 * Legacy format: { roundNum: items[] } - wrapped in default run ID
 * Modern format: { runId: { roundNum: items[] } }
 *
 * @param roundMapSchema - Schema for parsing the inner round map structure
 * @param options.defaultRunId - Run ID to use for legacy format (defaults to normalizeRunId(null))
 */
export function createLegacyAwareRunMapSchema<T>(
  roundMapSchema: z.ZodType<Map<number, T[]>>,
  options?: { defaultRunId?: string },
): z.ZodType<Map<string, Map<number, T[]>>> {
  const defaultRunId = options?.defaultRunId ?? normalizeRunId(null);

  return z.unknown().transform((data): Map<string, Map<number, T[]>> => {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const record = data as Record<string, unknown>;

    // Legacy format: all keys are numeric (round numbers)
    if (isLegacyNumericKeyFormat(record)) {
      const rounds = roundMapSchema.parse(record);
      return rounds.size > 0 ? new Map([[defaultRunId, rounds]]) : new Map();
    }

    // Modern format: keys are run IDs
    const runMap = new Map<string, Map<number, T[]>>();
    for (const [runId, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object') continue;
      const rounds = roundMapSchema.parse(value);
      if (rounds.size > 0) {
        runMap.set(runId, rounds);
      }
    }
    return runMap;
  }) as z.ZodType<Map<string, Map<number, T[]>>>;
}

/**
 * Factory for creating schemas that handle both legacy flat format and modern run map format
 * for single-value items (not arrays per round).
 *
 * Legacy format: { field: value } - single flat object wrapped in default run ID
 * Modern format: { runId: { field: value } }
 *
 * @param itemSchema - Schema for parsing individual item values
 * @param isLegacyFormat - Function to detect if data is in legacy format
 */
export function createLegacyAwareSingleValueRunMapSchema<T>(
  itemSchema: z.ZodType<T>,
  isLegacyFormat: (data: Record<string, unknown>) => boolean,
  options?: { defaultRunId?: string },
): z.ZodType<Map<string, T>> {
  const defaultRunId = options?.defaultRunId ?? normalizeRunId(null);

  return z.unknown().transform((data): Map<string, T> => {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const record = data as Record<string, unknown>;

    // Legacy format: flat object
    if (isLegacyFormat(record)) {
      const item = itemSchema.parse(data);
      return new Map([[defaultRunId, item]]);
    }

    // Modern format: keys are run IDs
    const runMap = new Map<string, T>();
    for (const [runId, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object') continue;
      const result = itemSchema.safeParse(value);
      if (result.success) {
        runMap.set(runId, result.data);
      }
    }
    return runMap;
  }) as z.ZodType<Map<string, T>>;
}
