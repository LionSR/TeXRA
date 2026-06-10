/**
 * ProgressView shared field schemas and data payload schemas. These carry no
 * IPC `command` wrapper so both the outbound and inbound message modules can
 * compose them without a circular import.
 */
import { z } from 'zod';

import { AgentCategorySchema } from '../agent';

// ============================================================
// Shared Field Schemas
// ============================================================

export const AgentCategoryFilterSchema = z.union([
  z.literal('all'),
  AgentCategorySchema,
]);
export type AgentCategoryFilter = z.infer<typeof AgentCategoryFilterSchema>;

export const ProgressViewPlacementSchema = z.enum(['sidebar', 'editor']);
export type ProgressViewPlacement = z.infer<typeof ProgressViewPlacementSchema>;

// ============================================================
// Progress View Data Schemas
// ============================================================

export const MissingOutputsPayloadSchema = z.object({
  missing: z.array(z.string()).prefault([]),
  xmlFile: z.string().nullable().prefault(null),
  documentTag: z.string().nullable().prefault(null),
});

export const TOOL_USE_STATUS = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const;

const ToolUseStatusSchema = z.enum([
  TOOL_USE_STATUS.IN_PROGRESS,
  TOOL_USE_STATUS.COMPLETED,
]);

export const ToolUseLogSchema = z.object({
  toolName: z.string().optional(),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  isError: z.boolean().optional(),
  userInstruction: z.string().optional(),
  status: ToolUseStatusSchema.optional(),
});
export type ToolUseLog = z.infer<typeof ToolUseLogSchema>;

const NormalizedToolUseSchema = z.object({
  parsed: z.record(z.string(), z.unknown()),
  toolName: z.string(),
  errorText: z.string(),
  outputText: z.string(),
  userInstructionText: z.string(),
  input: z.unknown(),
  isError: z.boolean(),
  isUserFeedback: z.boolean(),
  headerSummary: z.string(),
  status: ToolUseStatusSchema.optional(),
});
export type NormalizedToolUse = z.infer<typeof NormalizedToolUseSchema>;

export const WebSearchResultItemSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  domain: z.string().optional(),
});
export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

export const WebSearchPayloadSchema = z.object({
  query: z.string().optional(),
  results: z.array(WebSearchResultItemSchema).optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
});
export type WebSearchPayload = z.infer<typeof WebSearchPayloadSchema>;

export const WebFetchPayloadSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  errorCode: z.string().optional(),
});
export type WebFetchPayload = z.infer<typeof WebFetchPayloadSchema>;
