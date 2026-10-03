/**
 * A tool plugin's dashboard category and the availability of its external
 * dependency, as the plugin values (`@tools/plugins`), the availability
 * probes and every Tools dashboard read them.
 */
import { z } from 'zod';

/** Availability of a tool dependency (not a tool call's `ToolCallStatus`). */
export const ToolDependencyStatusSchema = z.enum([
  'available',
  'not-found',
  'unknown',
]);
export type ToolDependencyStatus = z.infer<typeof ToolDependencyStatusSchema>;

export const ToolCategorySchema = z.enum([
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
export type ToolCategory = z.infer<typeof ToolCategorySchema>;
