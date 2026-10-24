/**
 * A tool plugin's dashboard category and the availability of its external
 * dependency, as the plugin values (`@tools/plugins`), the availability
 * probes and every Tools dashboard read them.
 */
import { Schema } from 'effect';

/** Availability of a tool dependency (not a tool call's `ToolCallStatus`). */
export const ToolDependencyStatusSchema = Schema.Literals([
  'available',
  'not-found',
  'unknown',
]);
export type ToolDependencyStatus = typeof ToolDependencyStatusSchema.Type;

export const ToolCategorySchema = Schema.Literals([
  'file',
  'latex',
  'academic',
  'web',
  'computation',
  'lean',
  'workflow',
  'system',
  'ai-agents',
]);
export type ToolCategory = typeof ToolCategorySchema.Type;
