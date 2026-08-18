// Node imports
import { createHash, type BinaryLike } from 'node:crypto';

// Third-party imports
import stableStringify from 'fast-json-stable-stringify';

// Local imports - schemas
import type { ExecutionId } from '@shared/schemas';

type ExecutionIdentity = Readonly<Record<string, string | number>>;

/** Stable hex prefix of a sha256 digest. */
export function truncatedHexId(source: BinaryLike, length: number): string {
  return createHash('sha256').update(source).digest('hex').slice(0, length);
}

/** Derive a stable execution ID from named identity fields. */
export function deriveExecutionId(identity: ExecutionIdentity): ExecutionId {
  return truncatedHexId(stableStringify(identity), 24) as ExecutionId;
}
