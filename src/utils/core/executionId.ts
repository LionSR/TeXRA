import { randomBytes } from 'crypto';

import type { ExecutionId } from '@shared/schemas';

/** Generate a compact 8-char hex execution ID (32 bits of entropy). */
export function generateExecutionId(): ExecutionId {
  return randomBytes(4).toString('hex') as ExecutionId;
}
