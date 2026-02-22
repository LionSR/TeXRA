// Third-party imports
import { z } from 'zod';

// =============================================================================
// Round/Run Map Schema Factories (for nested structures)
// =============================================================================

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
