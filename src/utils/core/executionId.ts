import { customAlphabet } from 'nanoid';

import type { ExecutionId } from '@shared/schemas';

/**
 * Generate a 12-char lowercase-hex ID (48 bits of entropy). Shared by
 * schemas that constrain IDs to hex (execution IDs, inquiry thread IDs,
 * goal IDs).
 */
export const hexId12 = customAlphabet('0123456789abcdef', 12);

/** Generate a compact 12-char hex execution ID (48 bits of entropy). */
export function generateExecutionId(): ExecutionId {
  return hexId12() as ExecutionId;
}
