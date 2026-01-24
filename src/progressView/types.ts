// Third-party imports
import { z } from 'zod';

// ============================================================================
// Progress View Schemas
// ============================================================================

export const InstructionMetadataSchema = z.object({
  showToggle: z.boolean().optional(),
});
export type InstructionMetadata = z.infer<typeof InstructionMetadataSchema>;

export const InstructionUpdateSchema = z.object({
  text: z.string(),
  metadata: InstructionMetadataSchema.optional(),
  /** Timestamp when the instruction was submitted (epoch milliseconds) */
  timestamp: z.number().optional(),
});
export type InstructionUpdate = z.infer<typeof InstructionUpdateSchema>;

// ============================================================================
// Round Data Types
// ============================================================================

/**
 * Map from round number to items for that round.
 * Used for output files, missing outputs, etc. that are organized by round.
 */
export type RoundMap<T> = Map<number, T[]>;

/**
 * Map from run ID to round maps (run → round → items).
 * Nested structure for per-run, per-round data.
 */
export type RunRoundMap<T> = Map<string, RoundMap<T>>;
