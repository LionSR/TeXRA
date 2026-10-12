// Node imports
import { hash, type BinaryLike } from 'node:crypto';

// Third-party imports
import stableStringify from 'safe-stable-stringify';

// Local imports - schemas
import type { RunId } from '@shared/schemas';

type RunIdFields = Readonly<Record<string, string | number>>;

/** Hex sha256 of a value's stable JSON form. */
export const sha256 = (value: unknown): string =>
  hash('sha256', stableStringify(value) ?? '', 'hex');

/** Hex sha256 of raw text or bytes. */
export const sha256Hex = (source: BinaryLike): string =>
  hash('sha256', source, 'hex');

/** Stable hex prefix of a sha256 digest. */
export function truncatedHexId(source: BinaryLike, length: number): string {
  return sha256Hex(source).slice(0, length);
}

/** Derive a stable run id from named identity fields: one of the two
 *  minting sites (`generateRunId` is the other), so the brand is
 *  applied here and nowhere downstream. */
export function deriveRunId(identity: RunIdFields): RunId {
  return truncatedHexId(stableStringify(identity), 24) as RunId;
}
