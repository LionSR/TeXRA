// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import stableStringify from 'fast-json-stable-stringify';

// Local imports - schemas
import type { ExecutionId } from '@shared/schemas';

type ExecutionIdentity = Readonly<Record<string, string | number>>;

/** Derive a stable execution ID from named identity fields. */
export function deriveExecutionId(identity: ExecutionIdentity): ExecutionId {
  return createHash('sha256')
    .update(stableStringify(identity))
    .digest('hex')
    .slice(0, 24) as ExecutionId;
}
