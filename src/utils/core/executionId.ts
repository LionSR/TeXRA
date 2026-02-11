import { randomBytes } from 'crypto';

import type { ExecutionId } from '@shared/schemas';

/** Generate a compact 12-char hex execution ID (48 bits of entropy). */
export function generateExecutionId(): ExecutionId {
  return randomBytes(6).toString('hex') as ExecutionId;
}
