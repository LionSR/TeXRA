import { z } from 'zod';

export const ContextManagementAction = z.enum([
  'compaction',
  'clear_tool_uses',
  'clear_thinking',
  'truncation',
  'max_tokens_reduced',
]);
export type ContextManagementAction = z.infer<typeof ContextManagementAction>;

const TokenCountSchema = z.int().nonnegative();
const PositiveTokenCountSchema = z.int().positive();

export const ContextManagementDataSchema = z.object({
  action: ContextManagementAction,
  tokensBefore: TokenCountSchema,
  tokensAfter: TokenCountSchema.optional(),
  contextWindow: PositiveTokenCountSchema,
  utilizationBefore: z.number().nonnegative(),
  utilizationAfter: z.number().nonnegative().optional(),
  details: z.string().optional(),
  summary: z.string().optional(),
  originalMaxTokens: PositiveTokenCountSchema.optional(),
  reducedMaxTokens: PositiveTokenCountSchema.optional(),
});

export type ContextManagementData = z.infer<typeof ContextManagementDataSchema>;

export const ContextStateDataSchema = z.object({
  inputTokens: TokenCountSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationPercent: z.number().nonnegative(),
});

export type ContextStateData = z.infer<typeof ContextStateDataSchema>;
