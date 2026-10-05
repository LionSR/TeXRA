import { z } from 'zod';

import { TokenCountSchema } from './usage';

const ContextManagementAction = z.enum([
  'compaction',
  'clear_tool_uses',
  'clear_thinking',
  'truncation',
  'max_tokens_reduced',
]);

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
  action: ContextManagementAction.exclude(['max_tokens_reduced']),
  tokensAfter: TokenCountSchema,
  utilizationAfter: z.number().nonnegative(),
});

export const ContextManagementDataSchema = z.discriminatedUnion('action', [
  MaxTokensReducedDataSchema,
  TokensFreedDataSchema,
]);

export type ContextManagementData = z.infer<typeof ContextManagementDataSchema>;

/**
 * Lifecycle event for one context-compaction operation. Completion statistics
 * remain in {@link ContextManagementDataSchema}; this smaller payload lets
 * hosts project one stable activity row from start through its terminal state.
 */
export const CompactionActivityDataSchema = z.object({
  activity: z.literal('context_compaction'),
  operationId: z.string().min(1),
  state: z.enum(['started', 'completed', 'failed', 'cancelled', 'skipped']),
});

export type CompactionActivityData = z.infer<
  typeof CompactionActivityDataSchema
>;
export type CompactionActivityOutcome = Exclude<
  CompactionActivityData['state'],
  'started'
>;

export const ContextStateDataSchema = z.object({
  inputTokens: TokenCountSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationPercent: z.number().nonnegative(),
});

export type ContextStateData = z.infer<typeof ContextStateDataSchema>;
