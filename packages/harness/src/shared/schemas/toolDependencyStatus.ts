import { Schema } from 'effect';

/** Whether a tool plugin's external dependency is there, as the
 *  availability probes find it (not a tool call's `ToolCallStatus`). */
export const ToolDependencyStatusSchema = Schema.Literals([
  'available',
  'not-found',
  'unknown',
]);
export type ToolDependencyStatus = typeof ToolDependencyStatusSchema.Type;
