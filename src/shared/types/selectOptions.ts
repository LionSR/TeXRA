/**
 * Typed data structures for select options.
 *
 * These types replace the HTML string approach with structured data
 * that can be rendered using Lit templates.
 */

import { z } from 'zod/v4';

// =============================================================================
// BASE OPTION SCHEMA
// =============================================================================

export const SelectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  disabled: z.boolean().optional(),
});

export type SelectOption = z.infer<typeof SelectOptionSchema>;

// =============================================================================
// AGENT OPTION SCHEMA
// =============================================================================

export const AgentOptionSchema = SelectOptionSchema.extend({
  isMultiple: z.boolean().optional(),
  isToolUse: z.boolean().optional(),
  isRemote: z.boolean().optional(),
  isCustom: z.boolean().optional(),
  description: z.string().optional(),
});

export type AgentOption = z.infer<typeof AgentOptionSchema>;

// =============================================================================
// MODEL OPTION SCHEMA
// =============================================================================

export const ModelOptionSchema = SelectOptionSchema.extend({
  provider: z.string().optional(),
  context: z.string().optional(),
  cost: z.string().optional(),
  requiresKey: z.boolean().optional(),
});

export type ModelOption = z.infer<typeof ModelOptionSchema>;

// =============================================================================
// FILE OPTION SCHEMA (simple string options)
// =============================================================================

export const FileOptionSchema = SelectOptionSchema;
export type FileOption = SelectOption;

// =============================================================================
// COMMIT OPTION SCHEMA
// =============================================================================

export const CommitOptionSchema = z.object({
  hash: z.string(),
  label: z.string(),
});

export type CommitOption = z.infer<typeof CommitOptionSchema>;
