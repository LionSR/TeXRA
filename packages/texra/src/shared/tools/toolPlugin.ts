/**
 * The availability of a tool plugin's external dependency, as the plugin
 * values (`@tools/plugins`), the availability probes and every Tools
 * dashboard read it.
 */
import { Schema } from 'effect';

/** Availability of a tool dependency (not a tool call's `ToolCallStatus`). */
export const ToolDependencyStatusSchema = Schema.Literals([
  'available',
  'not-found',
  'unknown',
]);
export type ToolDependencyStatus = typeof ToolDependencyStatusSchema.Type;
