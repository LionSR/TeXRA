// Node imports
import { createHash, type BinaryLike } from 'node:crypto';

// Third-party imports
import stableStringify from 'safe-stable-stringify';

// Local imports - schemas
import type { RunId } from '@shared/schemas';

type RunIdFields = Readonly<Record<string, string | number>>;

/** Stable hex prefix of a sha256 digest. */
export function truncatedHexId(source: BinaryLike, length: number): string {
  return createHash('sha256').update(source).digest('hex').slice(0, length);
}

/** Derive a stable run id from named identity fields: one of the two
 *  minting sites (`generateRunId` is the other), so the brand is
 *  applied here and nowhere downstream. */
export function deriveRunId(identity: RunIdFields): RunId {
  return truncatedHexId(stableStringify(identity), 24) as RunId;
}
