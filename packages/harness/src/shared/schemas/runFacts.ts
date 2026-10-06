/**
 * The facts a run's rows carry beside its messages: its usage, its input
 * (system text, instruction, activated skills) and what it is bound to.
 * Host-neutral so the run history (`runHistoryEvent.ts`) composes them without reaching the agent
 * layer; the agent modules import them back.
 */
import { z } from 'zod';

import { ACTIVATED_SKILLS_MAX } from './activeSkills';
import { Sha256Schema } from './offeredTools';
import { QualifiedSkillNameSchema } from './skillName';
import { StoredProtocolSchema } from './storedTurn';
import {
  DeclinableUsageRouteSchema,
  type RunUsageTotals,
  TokenCountSchema,
  TokenUsageStatsSchema,
  UsageRouteSchema,
} from './usage';

// ---------------------------------------------------------------- usage

/**
 * Normalized usage statistics from any model provider: the ONLY usage type
 * after API response extraction. The package's `TurnResult.usage` is priced
 * into this shape by `run/pricing.ts`.
 *
 * Reuses only the required base fields via `.pick()` — the optional cache
 * fields on `TokenUsageStatsSchema` (`cacheReadInputTokens` /
 * `cacheCreationInputTokens`) are never populated for a NormalizedUsage; the
 * live cache metrics below (`cachedInputTokens` / `cacheCreationTokens`) are
 * the authoritative names. Extending the full base instead would inherit
 * those dead fields and duplicate `cacheMissInputTokens`.
 */
export const NormalizedUsageSchema = TokenUsageStatsSchema.pick({
  inputTokens: true,
  outputTokens: true,
  cost: true,
}).extend({
  /** Response time in milliseconds */
  responseTimeMs: z.number().nonnegative(),
  /** Wire surface that produced this usage; usage is billed per surface. */
  provider: StoredProtocolSchema,

  // Optional metrics (when supported by provider)
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens: TokenCountSchema.optional(),
  /** Tokens that missed provider prompt cache and were billed at full input rate */
  cacheMissInputTokens: TokenCountSchema.optional(),
  /** Tokens written to cache - Anthropic only (increases cost by 1.25x) */
  cacheCreationTokens: TokenCountSchema.optional(),
  /** Tokens used for reasoning (o1, DeepSeek-R1, Gemini thinking) */
  reasoningTokens: TokenCountSchema.optional(),
  /** Tokens consumed by tool use prompts (Google) */
  toolUsePromptTokens: TokenCountSchema.optional(),
  /** Canonical route used for usage display and telemetry. */
  usageRoute: UsageRouteSchema.optional(),
  /** The route's subscription plan, when it names one; display-only. */
  usagePlan: z.string().optional(),
});
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;

/**
 * The priced usage the writer stamped on one completed turn, summed into the
 * run totals. The package's `turn.usage` is deliberately not the input: it
 * carries token counts and provider-specific extras but no runtime price, so
 * folding it would leave a resumed run's `totalCost` at zero. Every field of the totals is named here, so a new
 * metric on either schema is a compile error rather than a silent zero.
 */
export function addTurnUsage(
  totals: RunUsageTotals,
  usage: NormalizedUsage | null,
): RunUsageTotals {
  if (usage === null) return totals;
  return {
    firstInputTokens:
      totals.firstInputTokens === 0
        ? usage.inputTokens
        : totals.firstInputTokens,
    totalInputTokens: totals.totalInputTokens + usage.inputTokens,
    totalOutputTokens: totals.totalOutputTokens + usage.outputTokens,
    totalCost: totals.totalCost + usage.cost,
    totalCacheReadInputTokens:
      totals.totalCacheReadInputTokens + (usage.cachedInputTokens ?? 0),
    totalCacheMissInputTokens:
      totals.totalCacheMissInputTokens + (usage.cacheMissInputTokens ?? 0),
    totalCacheCreationInputTokens:
      totals.totalCacheCreationInputTokens + (usage.cacheCreationTokens ?? 0),
    totalReasoningTokens:
      totals.totalReasoningTokens + (usage.reasoningTokens ?? 0),
    totalToolUsePromptTokens:
      totals.totalToolUsePromptTokens + (usage.toolUsePromptTokens ?? 0),
  };
}

// ------------------------------------------------------------ launch facts

export const AttachedMemoryMissSchema = z.object({
  path: z.string(),
  reason: z.string(),
});
export type AttachedMemoryMiss = z.infer<typeof AttachedMemoryMissSchema>;

/** One skill in a step's catalog, as the prompt lists it, with the plugin
 *  that ships it (null for a core source) and the directory tools may read
 *  while a step lists or activated it (null when the workspace already
 *  holds it). A step discovers its catalog; the system text it sends and
 *  the names it lists are what is recorded. */
export interface SkillCatalogEntry {
  readonly plugin: string | null;
  readonly name: string;
  readonly text: string;
  readonly directory: string | null;
}

// ---------------------------------------------------------- model backend

/**
 * Who serves a run's conversation: the provider plugin its route lands on
 * (`openRouter`, `copilot`, or the model's own provider, whose plugin names
 * the protocol), or the internal validation model. A run keeps its backend:
 * a resume or a model switch rebinds it, whatever the OpenRouter and Copilot
 * preferences say now.
 */
export const ModelBackendSchema = z.enum([
  'validation',
  'openRouter',
  'copilot',
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
  'minimax',
  'glm',
  'meta',
]);
/** Who serves a run's conversation ({@link ModelBackendSchema}). */
export type ModelBackend = z.infer<typeof ModelBackendSchema>;

// ------------------------------------------------------------ run input

/**
 * What a run's turns answer besides their messages, recorded on the row that
 * changes it: a fresh run's opening `append`, a delivery's `append`, or a
 * fork's seeding `context.edit`. The fold keeps the latest value of each
 * field (`RunState.input`); a row names only what it changes.
 */
export const RunInputSchema = z.strictObject({
  /** The address of the run's system text, before what each step adds
   *  (`stepInstructions`): a `context.blob` of the run. */
  system: Sha256Schema.optional(),
  /** The address of the instruction the run's latest turn answers, a
   *  `context.blob`; `null` returns to the launch's instruction. */
  instruction: Sha256Schema.nullable().optional(),
  /** The names of the skills the run's user activated: each step resolves
   *  them against its own catalog, and grants one while its plugin, if any,
   *  still contributes. */
  activated: z
    .array(QualifiedSkillNameSchema)
    .max(ACTIVATED_SKILLS_MAX)
    .optional(),
  /** The attached memories the opening could not read. */
  memoryMisses: z.array(AttachedMemoryMissSchema).optional(),
});
/** What a run's turns answer besides their messages ({@link RunInputSchema}). */
export type RunInput = z.infer<typeof RunInputSchema>;

/**
 * What a run is bound to beyond its model id, recorded on its `run.config`
 * once it binds: the backend a resume or a switch rebinds on, whatever the
 * provider preferences say by then, and the subscription routes its launch
 * declined (an own-API-key fallback declines them all). Routes declined by a
 * later retry are folded from that retry's decision.
 */
export const RunBindingSchema = z.strictObject({
  backend: ModelBackendSchema,
  declinedRoutes: z.array(DeclinableUsageRouteSchema).readonly(),
});
/** What a run is bound to beyond its model id ({@link RunBindingSchema}). */
export type RunBinding = z.infer<typeof RunBindingSchema>;
