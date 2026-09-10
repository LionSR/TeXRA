import { z } from 'zod';

/**
 * The one id a run has (one run model, R4): minted once at launch, assigned
 * at `run.start`, and the key of every fact about that run. Hex: 12 chars
 * when generated, 24 when derived from a checkpoint identity. Branded so a
 * string that was never minted as a run id cannot be passed for one.
 */
export const RunIdSchema = z
  .string()
  .min(6)
  .regex(/^[0-9a-f][-0-9a-f]*$/i, 'Invalid run ID: expected hex')
  .brand<'RunId'>();
export type RunId = z.infer<typeof RunIdSchema>;

/** A run id, or the empty-string sentinel meaning "no active run". */
export const StreamSelectionSchema = z.union([RunIdSchema, z.literal('')]);
