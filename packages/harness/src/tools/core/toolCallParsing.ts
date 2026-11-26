import { Schema } from 'effect';

import { toErrorMessage } from '@utils/errors/errorMessage';

/** A tool call's failure as the model reads it: the tool's name and the
 *  failure's message, a schema failure's as its rendered issue tree. */
export function normalizeToolCallError(
  toolName: string,
  error: unknown,
): string {
  return error instanceof Schema.SchemaError
    ? `${toolName}: Invalid parameters:\n${error.message}`
    : `${toolName}: ${toErrorMessage(error)}`;
}
