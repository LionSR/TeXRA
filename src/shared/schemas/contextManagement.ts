import { z } from 'zod';

export const ContextManagementAction = z.enum([
  'compaction',
  'clear_tool_uses',
  'clear_thinking',
  'truncation',
  'max_tokens_reduced',
]);
export type ContextManagementAction = z.infer<typeof ContextManagementAction>;

export const ContextManagementDataSchema = z.object({
  action: ContextManagementAction,
  tokensBefore: z.number().nonnegative(),
  tokensAfter: z.number().nonnegative().optional(),
  contextWindow: z.number().positive(),
  utilizationBefore: z.number().nonnegative(),
  utilizationAfter: z.number().nonnegative().optional(),
  details: z.string().optional(),
  originalMaxTokens: z.number().positive().optional(),
  reducedMaxTokens: z.number().positive().optional(),
});

export type ContextManagementData = z.infer<typeof ContextManagementDataSchema>;

export const ContextStateDataSchema = z.object({
  inputTokens: z.number().nonnegative(),
  contextWindow: z.number().positive(),
  utilizationPercent: z.number().nonnegative(),
});

export type ContextStateData = z.infer<typeof ContextStateDataSchema>;
