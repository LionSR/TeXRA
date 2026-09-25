/**
 * The agent flow state a `flow.snapshot` row restores: the run-state and
 * workspace snapshots, the user-variable channels, the model compatibility
 * key, and the message-free core of each flow family. Host-neutral so the run
 * ledger (`runLedgerEvent.ts`) composes them without reaching the agent
 * layer; the agent modules import them back, and the two family modules
 * `.extend()` their core with the one provider-message field, which is the
 * only field of either family state that names a provider SDK type.
 */
import { z } from 'zod';

import { TurnProtocolSchema } from '@texra-ai/llm/turn';

import { JsonValueSchema } from './jsonValue';
import { LineCountSchema } from './lineChanges';
import { FileLocationSchema } from './output';
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
 * folding it would make a resumed run's `totalCost` the sum of `tool.result`
 * add operations alone. Every field of the totals is named here, so a new
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

// ------------------------------------------------------- user variables

export const AttachedMemoryMissSchema = z.object({
  path: z.string(),
  reason: z.string(),
});
export type AttachedMemoryMiss = z.infer<typeof AttachedMemoryMissSchema>;

/**
 * The fixed template-variable vocabulary `buildUserVars`
 * (`@agent/prompt/userVars`) produces for prompt rendering — one validator per
 * runtime token, and the single source of truth for the vocabulary: the
 * {@link UserVars} type is inferred from it, the persisted channel shape below
 * is built from its shape, and `@agent/prompt/userVars` derives its
 * passthrough token list from the same keys. The object is closed on purpose:
 * a misspelled fixed variable is a compile error at the producer and at every
 * typed reader instead of a silently empty substitution.
 *
 * Agent-YAML `requiredFilesInternal` variables have user-defined names, so
 * they are not in this vocabulary; they ride beside it as custom string keys
 * (see `TemplateVars` in `@agent/core/definition/AgentCycleOptions`) and only
 * templates read them.
 *
 * The schema lives beside the channels below, not in the prompt layer, because
 * `UserVariableChannels` (persisted and resumed by the tool-use flow) is its
 * primary carrier.
 */
const UserVarsSchema = z.object({
  /** Live model id for the run. */
  MODEL: z.string(),
  /** Current user instruction. */
  INSTRUCTION: z.string(),
  /** Provider gate for Anthropic-specific prompt blocks. */
  IS_ANTHROPIC_MODEL: z.boolean(),
  /** Workspace root the run operates in. */
  CWD: z.string(),
  /** Configured default bibliography path, '' when unset. */
  DEFAULT_BIB_PATH: z.string(),
  /** Absolute agent-directory paths from the external-roots registry, '' when unregistered. */
  BUILTIN_WORKFLOW_DIR: z.string(),
  BUILTIN_TOOLUSE_DIR: z.string(),
  CUSTOM_AGENTS_DIR: z.string(),
  AGENT_DOCS_DIR: z.string(),
  /** Per-category primary file and its content, null when none is readable. */
  INPUT_FILE: z.string().nullable(),
  INPUT_CONTENT: z.string().nullable(),
  CONTEXT_FILE: z.string().nullable(),
  CONTEXT_CONTENT: z.string().nullable(),
  EDITED_FILE: z.string().nullable(),
  EDITED_CONTENT: z.string().nullable(),
  /** Per-category readable files as prompt-displayed names. */
  INPUT_FILES: z.array(z.string()),
  CONTEXT_FILES: z.array(z.string()),
  EDITED_FILES: z.array(z.string()),
  /** Per-category XML bundle of readable files, null when none are readable. */
  ALL_INPUTS: z.string().nullable(),
  ALL_CONTEXTS: z.string().nullable(),
  ALL_EDITEDS: z.string().nullable(),
  /** Per-category comma-separated readable file list, '' when empty. */
  LIST_OF_ALL_INPUTS: z.string(),
  LIST_OF_ALL_CONTEXTS: z.string(),
  LIST_OF_ALL_EDITEDS: z.string(),
  /** First attached media file; content is never inlined (display-only). */
  MEDIA_FILE: z.string().nullable(),
  /** Resolved output file list; absent when no usable outputs are configured. */
  OUTPUT_FILES: z.array(z.string()).optional(),
  /**
   * Retired: the codex / claude_code guidance now lives in those tools'
   * descriptions and nothing writes these. Kept so the stored session format
   * (pinned by sessionEventFormat.vitest.ts) does not move. They stay in the
   * runtime token list, so a custom template that still names them renders
   * an empty string.
   */
  CODEX_GUIDANCE: z.string().optional(),
  CLAUDE_CODE_GUIDANCE: z.string().optional(),
  /** Effective round count; workflow agents only. */
  ROUNDS: z.number().optional(),

  /** XML block of attached memory contents, null when none are attached. */
  ATTACHED_MEMORIES: z.string().nullable(),
  /** Attached memories that could not be read. */
  ATTACHED_MEMORY_MISSES: z.array(AttachedMemoryMissSchema),
  /** Pre-rendered skill catalog, '' when skills are disabled or unavailable. */
  AVAILABLE_SKILLS: z.string(),
});

/** Derived from UserVarsSchema - single source of truth. */
export type UserVars = z.infer<typeof UserVarsSchema>;

/**
 * The persisted channel shape is a loose record because a run's custom
 * `requiredFilesInternal` keys are not enumerable here; each known fixed key
 * is validated with its per-key type when present, and the custom keys pass
 * through untouched. Known keys are optional because a checkpoint may have
 * dropped variables.
 */
export const UserVariableChannelsSchema = z
  .looseObject(UserVarsSchema.shape)
  .partial();

/** Derived from UserVariableChannelsSchema - single source of truth. */
export type UserVariableChannels = z.output<typeof UserVariableChannelsSchema>;

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

// -------------------------------------------------------- family cores

const StateSlicesSchema = z.object({
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  userChannels: UserVariableChannelsSchema,
});

/**
 * The message-free core of one tool-use flow's shared state: every field of
 * `ToolUseRunSharedSchema` except `messages`, which the agent module adds.
 *
 * Default `z.object` semantics by decision (#10641), matching reflection's
 * core: unknown top-level keys in a persisted record are accepted but
 * stripped at this parse boundary, and the resumed flow's first persisted
 * step then rewrites the stripped record. Deliberately not `z.strictObject`
 * — a record written by a newer build carrying keys this build does not know
 * must still resume — and no `.catch`: malformed known fields must keep
 * failing loudly.
 */
export const ToolUseSnapshotStateSchema = z.object({
  stateSlices: StateSlicesSchema.nullable(),
  /**
   * The tool names the run was offered at open, in offer order, restated
   * unchanged by every later snapshot. A resume offers these names that
   * still resolve and never a tool the run was not offered.
   */
  offeredTools: z.array(z.string().min(1)).readonly(),
  /** sha256 over the canonical JSON of each offered name and input schema.
   *  Descriptions are excluded: delegation annotations rewrite them. */
  toolsetHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Per-call system text for providers that do not embed it in messages. */
  systemPrompt: z.string().optional(),
  /** Validated terminal-tool result retained across interrupt and resume. */
  structured: JsonValueSchema.optional(),
});

/**
 * The message-free core of one reflection flow's shared state: the round
 * budget, the workspace (top-level: reflection has no `stateSlices` and no
 * `userChannels`) and the compile-rejection facts no row carries. The round
 * is `runtime.round`, the output location is derived from it, and whether
 * the round's response ended the turn is derived from the folded last turn.
 */
export const ReflectionSnapshotStateSchema = z.object({
  /** The round budget. No row carries it; the CLI's continuability read
   *  compares `runtime.round` against it. */
  totalRounds: z.int().nonnegative(),

  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,

  /** One-shot compile-failure feedback injected into the next round prompt. */
  compileFailureContext: z.string().optional(),

  /** Rejected compile result awaiting an explicit successful compile. */
  unresolvedCompileRejection: z.boolean().optional(),
});

/**
 * Whether a reflection run holds a compile rejection it can no longer clear:
 * the last round's compile was rejected and no round is left to fix it, so
 * continuing only replays the same rejection. The loop fails its outcome on
 * it and the CLI refuses to offer such a snapshot as continuable.
 */
export function isTerminalCompileRejection(
  state: Pick<
    z.output<typeof ReflectionSnapshotStateSchema>,
    'unresolvedCompileRejection' | 'totalRounds'
  >,
  round: number,
): boolean {
  return (
    state.unresolvedCompileRejection === true && round + 1 >= state.totalRounds
  );
}
