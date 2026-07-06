import { z } from 'zod';

import { TokenCountSchema } from './usage';

export const ContextManagementAction = z.enum([
  'compaction',
  'clear_tool_uses',
  'clear_thinking',
  'truncation',
  'max_tokens_reduced',
]);
export type ContextManagementAction = z.infer<typeof ContextManagementAction>;

const PositiveTokenCountSchema = z.int().positive();

const ContextManagementDataBaseSchema = z.object({
  tokensBefore: TokenCountSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationBefore: z.number().nonnegative(),
  details: z.string().optional(),
  summary: z.string().optional(),
});

const MaxTokensReducedDataSchema = ContextManagementDataBaseSchema.extend({
  action: z.literal('max_tokens_reduced'),
  originalMaxTokens: PositiveTokenCountSchema,
  reducedMaxTokens: PositiveTokenCountSchema,
});

const TokensFreedDataSchema = ContextManagementDataBaseSchema.extend({
  action: z.enum([
    'compaction',
    'clear_tool_uses',
    'clear_thinking',
    'truncation',
  ]),
  tokensAfter: TokenCountSchema,
  utilizationAfter: z.number().nonnegative(),
});

export const ContextManagementDataSchema = z.discriminatedUnion('action', [
  MaxTokensReducedDataSchema,
  TokensFreedDataSchema,
]);

export type ContextManagementData = z.infer<typeof ContextManagementDataSchema>;

export const ContextStateDataSchema = z.object({
  inputTokens: TokenCountSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationPercent: z.number().nonnegative(),
});

export type ContextStateData = z.infer<typeof ContextStateDataSchema>;
