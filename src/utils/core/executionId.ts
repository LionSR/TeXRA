import { randomBytes } from 'crypto';

import type { ExecutionId } from '@shared/schemas';

/** Generate a compact 16-char hex execution ID (64 bits of entropy). */
export function generateExecutionId(): ExecutionId {
  return randomBytes(8).toString('hex') as ExecutionId;
}
