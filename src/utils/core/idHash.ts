// Node imports
import { createHash, type BinaryLike } from 'node:crypto';

// Third-party imports
import stableStringify from 'fast-json-stable-stringify';

// Local imports - schemas
import type { ExecutionId } from '@shared/schemas';

type ExecutionIdentity = Readonly<Record<string, string | number>>;

/**
 * Algorithms used by truncated hex IDs. `sha1` is compile-log only — drop
 * that member with the 2026-11-09 legacy compile-log spellings.
 */
export type TruncatedHexAlgorithm = 'sha256' | 'sha1';

/** Stable hex prefix of a digest. Default algorithm is sha256. */
export function truncatedHexId(
  source: BinaryLike,
  length: number,
  algorithm: TruncatedHexAlgorithm = 'sha256',
): string {
  return createHash(algorithm).update(source).digest('hex').slice(0, length);
}

/** Derive a stable execution ID from named identity fields. */
export function deriveExecutionId(identity: ExecutionIdentity): ExecutionId {
  return truncatedHexId(stableStringify(identity), 24) as ExecutionId;
}
