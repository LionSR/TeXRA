/**
 * The agent flow state a `run.snapshot` row restores: the run-state and
 * workspace snapshots, the model compatibility key, and the message-free
 * core of the tool-use flow. Host-neutral so the
 * run ledger (`runLedgerEvent.ts`) composes them without reaching the agent
 * layer; the agent modules import them back.
 */
import { z } from 'zod';

import { TurnProtocolSchema } from '@texra-ai/llm/turn';

import { ACTIVATED_SKILLS_MAX, SKILL_CATALOG_MAX_SKILLS } from './activeSkills';
import { JsonValueSchema } from './jsonValue';
import { LineCountSchema } from './lineChanges';
import { Sha256Schema } from './offeredTools';
import { FileLocationSchema } from './output';
import { QualifiedSkillNameSchema } from './skillName';
import {
  type RunUsageTotals,
  TokenCountSchema,
  TokenUsageStatsSchema,
  UsageRouteSchema,
} from './usage';
import { WorkPlanSnapshotSchema } from './workPlan';

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
  provider: TurnProtocolSchema,

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
  /** Number of server-side tool executions (Anthropic web search) */
  serverToolRequests: TokenCountSchema.optional(),
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
    totalServerToolRequests:
      totals.totalServerToolRequests + (usage.serverToolRequests ?? 0),
    totalResponseTimeMs: totals.totalResponseTimeMs + usage.responseTimeMs,
  };
}

// ------------------------------------------------------------ workspace

/** Schema for thinking blocks (carried in persisted messages). */
const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});

/** Response assembly state. */
const ResponseAssemblyStateSchema = z.object({
  lastResponse: z.string().prefault(''),
  accumulatedOutput: z.string().prefault(''),
});

/** Flattened file-edit records. */
const FileEditSnapshotSchema = z.object({
  path: z.string(),
  added: LineCountSchema.prefault(0),
  removed: LineCountSchema.prefault(0),
});

/** File interaction state snapshot. */
const FileInteractionStateSnapshotSchema = z.object({
  readFiles: z.array(z.string()).prefault([]),
  edits: z.array(FileEditSnapshotSchema).prefault([]),
  toolCallCount: z.int().nonnegative().prefault(0),
});

/** Media attachment state snapshot. */
const MediaAttachmentStateSnapshotSchema = z.object({
  files: z.array(FileLocationSchema).prefault([]),
});

/** Reasoning cache state. */
const ReasoningCacheStateSchema = z.object({
  thinkingBlocks: z.array(ThinkingBlockSchema).prefault([]),
});

/**
 * Canonical shape of an `AgentWorkspaceState` snapshot. Persisted workspace
 * state has one supported format; an older record (one written before
 * `workPlan` entered the shape) fails its resume parse here.
 */
export const AgentWorkspaceStateSnapshotSchema = z.object({
  assembly: ResponseAssemblyStateSchema.prefault({}),
  media: MediaAttachmentStateSnapshotSchema.prefault({}),
  reasoning: ReasoningCacheStateSchema.prefault({}),
  interactions: FileInteractionStateSnapshotSchema.prefault({}),
  workPlan: WorkPlanSnapshotSchema,
});
export type AgentWorkspaceSnapshot = z.output<
  typeof AgentWorkspaceStateSnapshotSchema
>;

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

/**
 * The catalog entries a step lists: those of core sources and of the
 * plugins it names, bounded after the filter, so a withdrawn plugin's skills
 * never push a listed one out.
 */
export const listedSkills = (
  catalog: readonly SkillCatalogEntry[],
  plugins: ReadonlySet<string>,
): SkillCatalogEntry[] =>
  catalog
    .filter(({ plugin }) => plugin === null || plugins.has(plugin))
    .slice(0, SKILL_CATALOG_MAX_SKILLS);

// --------------------------------------------------- model compatibility

const MODEL_COMPATIBILITY_KEYS = [
  'Validation',
  'OpenAIResponse',
  'OpenRouterNative',
  'VscodeLm',
  'Anthropic',
  'OpenAI',
  'GoogleInteractions',
  'DeepSeek',
  'XAI',
  'Kimi',
  'DashScope',
  'MiniMax',
  'GLM',
  'Meta',
] as const;
export type ModelCompatibilityKey = (typeof MODEL_COMPATIBILITY_KEYS)[number];
export const ModelCompatibilityKeySchema = z.enum(MODEL_COMPATIBILITY_KEYS);

// ------------------------------------------------------------ flow core

const StateSlicesSchema = z.object({
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
});

/**
 * The message-free state of a run's flow: the messages are folded from the
 * run's `model.message` rows.
 *
 * Default `z.object` semantics by decision (#10641): unknown top-level keys
 * in a persisted record are accepted but stripped at this parse boundary,
 * and the resumed flow's first persisted step then rewrites the stripped
 * record. Deliberately not `z.strictObject`
 * — a record written by a newer build carrying keys this build does not know
 * must still resume — and no `.catch`: malformed known fields must keep
 * failing loudly.
 */
export const ToolUseSnapshotStateSchema = z.object({
  stateSlices: StateSlicesSchema.nullable(),
  /** The address of the run's system text, before what each step adds
   *  (`stepInstructions`): a `context.blob` of the run, never restated in
   *  every snapshot. */
  system: Sha256Schema.optional(),
  /** The address of the instruction the run's latest turn answers, a
   *  `context.blob` recorded when a delivery changes it; absent while it is
   *  the launch's. */
  instruction: Sha256Schema.optional(),
  /** The names of the skills the run's user activated, recorded with the
   *  delivery that activated them: each step resolves them against its own
   *  catalog, and grants one while its plugin, if any, still contributes. */
  activated: z
    .array(QualifiedSkillNameSchema)
    .max(ACTIVATED_SKILLS_MAX)
    .optional(),
  /** The attached memories the opening could not read. */
  memoryMisses: z.array(AttachedMemoryMissSchema).optional(),
  /** Validated terminal-tool result retained across interrupt and resume. */
  structured: JsonValueSchema.optional(),
});
