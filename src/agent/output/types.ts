import type { FileLocation } from '@shared/schemas';

/** Internal mapping for file relationships (used by OutputHandler). All maps indexed by OUTPUT path. */
export interface RoundFileMapping {
  /** Output path → base FileLocation (for round-based diffs) */
  baseToOutput: Map<string, FileLocation>;
  /** Output path → previous round FileLocation (for inter-round diffs) */
  prevToOutput: Map<string, FileLocation>;
  /** Output path → original base FileLocation (for tracking lineage) */
  originByOutput: Map<string, FileLocation | undefined>;
}
