/**
 * The agent flow state a `flow.snapshot` row restores: the run-state and
 * workspace snapshots, the user-variable channels, the handler compatibility
 * key, and the message-free core of each flow family. Host-neutral so the run
 * ledger (`runLedgerEvent.ts`) composes them without reaching the agent
 * layer; the agent modules import them back, and the two family modules
 * `.extend()` their core with the one provider-message field, which is the
 * only field of either family state that names a provider SDK type.
 */
import { z } from 'zod';

import { JsonValueSchema } from './jsonValue';
import { LineCountSchema } from './lineChanges';
import {
  AgentFileLocationSchema,
  FileLocationSchema,
  RoundOutputSchema,
} from './output';
import {
  RunUsageTotalsSchema,
  TokenCountSchema,
  TokenUsageStatsSchema,
  UsageProviderSchema,
  UsageRouteSchema,
} from './usage';
import { WorkPlanSnapshotSchema } from './workPlan';

// ---------------------------------------------------------------- usage

/**
 * Normalized usage statistics from any model provider: the ONLY usage type
 * after API response extraction. Every model handler normalizes its
 * provider-specific usage to this shape.
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
  /** Provider that generated this usage data */
  provider: UsageProviderSchema,

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
});
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;

/**
 * Schema for RunUsageAccumulator JSON serialization. Only the most-recent
 * round's usage is needed at runtime, so `latestUsage` is the one carrier and
 * strict parsing rejects a blob carrying anything else: a snapshot that does
 * not match this shape fails loudly through the existing resume-parse failure
 * path instead of silently dropping usage.
 */
const RunUsageAccumulatorJSONSchema = z.strictObject({
  totals: RunUsageTotalsSchema.prefault({}),
  latestUsage: NormalizedUsageSchema.nullable().prefault(null),
});
export const AgentRunStateSnapshotSchema = z.object({
  totalRounds: z.int().nonnegative().prefault(0),
  totalResponseTimeMs: z.number().nonnegative().prefault(0),
  usageAccumulator: RunUsageAccumulatorJSONSchema.prefault({}),
});
export type AgentRunStateSnapshot = z.output<
  typeof AgentRunStateSnapshotSchema
>;

// ------------------------------------------------------------ workspace

/** Schema for thinking blocks (used by model handlers). */
const ThinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

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
 * (`@agent/prompt/userVars`) produces for prompt rendering — one known type
 * per runtime token. The type is closed on purpose: a misspelled fixed
 * variable is a compile error at the producer and at every typed reader
 * instead of a silently empty substitution.
 *
 * Agent-YAML `requiredFilesInternal` variables have user-defined names, so
 * they are not in this vocabulary; they ride beside it as custom string keys
 * (see `TemplateVars` in `@agent/core/definition/AgentCycleOptions`) and only
 * templates read them.
 *
 * The type lives beside the channels below, not in the prompt layer, because
 * `UserVariableChannels` (persisted and resumed by the tool-use flow) is its
 * primary carrier.
 */
export type UserVars = {
  /** Live model id for the run. */
  MODEL: string;
  /** Current user instruction. */
  INSTRUCTION: string;
  /** Provider gates for provider-specific prompt blocks. */
  IS_OPENAI_MODEL: boolean;
  IS_ANTHROPIC_MODEL: boolean;
  IS_GOOGLE_MODEL: boolean;
  /** Pre-rendered delegation rosters (the run's own agent excluded). */
  WORKFLOW_AGENTS: string;
  TOOL_USE_AGENTS: string;
  /** Workspace root the run operates in. */
  CWD: string;
  /** Configured default bibliography path, '' when unset. */
  DEFAULT_BIB_PATH: string;
  /** Absolute agent-directory paths from the external-roots registry, '' when unregistered. */
  BUILTIN_WORKFLOW_DIR: string;
  BUILTIN_TOOLUSE_DIR: string;
  CUSTOM_AGENTS_DIR: string;
  AGENT_DOCS_DIR: string;
  /** Per-category primary file and its content, null when none is readable. */
  INPUT_FILE: string | null;
  INPUT_CONTENT: string | null;
  CONTEXT_FILE: string | null;
  CONTEXT_CONTENT: string | null;
  EDITED_FILE: string | null;
  EDITED_CONTENT: string | null;
  /** Per-category readable files as prompt-displayed names. */
  INPUT_FILES: string[];
  CONTEXT_FILES: string[];
  EDITED_FILES: string[];
  /** Per-category XML bundle of readable files, null when none are readable. */
  ALL_INPUTS: string | null;
  ALL_CONTEXTS: string | null;
  ALL_EDITEDS: string | null;
  /** Per-category comma-separated readable file list, '' when empty. */
  LIST_OF_ALL_INPUTS: string;
  LIST_OF_ALL_CONTEXTS: string;
  LIST_OF_ALL_EDITEDS: string;
  /** First attached media file; content is never inlined (display-only). */
  MEDIA_FILE: string | null;
  /** Resolved output file list; absent when no usable outputs are configured. */
  OUTPUT_FILES?: string[];
  /** When-to-choose guidance, '' when the tool is not on the roster. */
  CODEX_GUIDANCE: string;
  CLAUDE_CODE_GUIDANCE: string;
  /** Effective round count; workflow agents only. */
  ROUNDS?: number;

  /** XML block of attached memory contents, null when none are attached. */
  ATTACHED_MEMORIES: string | null;
  /** Attached memories that could not be read. */
  ATTACHED_MEMORY_MISSES: AttachedMemoryMiss[];
  /** Pre-rendered skill catalog, '' when skills are disabled or unavailable. */
  AVAILABLE_SKILLS: string;
};

/**
 * Runtime validators for the fixed {@link UserVars} keys, and the runtime
 * view of the vocabulary itself: `@agent/prompt/userVars` derives its
 * passthrough token list from the channel schema's keys. Known keys are
 * optional in the persisted record because checkpoints may have dropped
 * variables; the `satisfies` clause keeps this map in lockstep with the
 * vocabulary. Custom `requiredFilesInternal` keys are not in this map and
 * pass through as unknown values via the loose record below.
 */
const UserVariableValueSchemas = {
  MODEL: z.string(),
  INSTRUCTION: z.string(),
  IS_OPENAI_MODEL: z.boolean(),
  IS_ANTHROPIC_MODEL: z.boolean(),
  IS_GOOGLE_MODEL: z.boolean(),
  WORKFLOW_AGENTS: z.string(),
  TOOL_USE_AGENTS: z.string(),
  CWD: z.string(),
  DEFAULT_BIB_PATH: z.string(),
  BUILTIN_WORKFLOW_DIR: z.string(),
  BUILTIN_TOOLUSE_DIR: z.string(),
  CUSTOM_AGENTS_DIR: z.string(),
  AGENT_DOCS_DIR: z.string(),
  INPUT_FILE: z.string().nullable(),
  INPUT_CONTENT: z.string().nullable(),
  CONTEXT_FILE: z.string().nullable(),
  CONTEXT_CONTENT: z.string().nullable(),
  EDITED_FILE: z.string().nullable(),
  EDITED_CONTENT: z.string().nullable(),
  INPUT_FILES: z.array(z.string()),
  CONTEXT_FILES: z.array(z.string()),
  EDITED_FILES: z.array(z.string()),
  ALL_INPUTS: z.string().nullable(),
  ALL_CONTEXTS: z.string().nullable(),
  ALL_EDITEDS: z.string().nullable(),
  LIST_OF_ALL_INPUTS: z.string(),
  LIST_OF_ALL_CONTEXTS: z.string(),
  LIST_OF_ALL_EDITEDS: z.string(),
  MEDIA_FILE: z.string().nullable(),
  OUTPUT_FILES: z.array(z.string()),
  CODEX_GUIDANCE: z.string(),
  CLAUDE_CODE_GUIDANCE: z.string(),
  ROUNDS: z.number(),

  ATTACHED_MEMORIES: z.string().nullable(),
  ATTACHED_MEMORY_MISSES: z.array(AttachedMemoryMissSchema),
  AVAILABLE_SKILLS: z.string(),
} satisfies {
  [K in keyof Required<UserVars>]-?: z.ZodType<Required<UserVars>[K]>;
};

/**
 * The persisted channel shape is a loose record because a run's custom
 * `requiredFilesInternal` keys are not enumerable here; each known fixed key
 * is validated with its per-key type when present, and the custom keys pass
 * through untouched.
 */
const UserVariableChannelRecordSchema = z
  .looseObject(UserVariableValueSchemas)
  .partial();

/** User variables for template rendering: one mutable record. */
export const UserVariableChannelsSchema = UserVariableChannelRecordSchema;
/** Derived from UserVariableChannelsSchema - single source of truth. */
export type UserVariableChannels = z.output<typeof UserVariableChannelsSchema>;

// ------------------------------------------------- handler compatibility

const MODEL_HANDLER_COMPATIBILITY_KEYS = [
  'ModelHandlerValidation',
  'ModelHandlerOpenAIResponse',
  'ModelHandlerOpenRouterNative',
  'ModelHandlerVscodeLm',
  'ModelHandlerAnthropic',
  'ModelHandlerOpenAI',
  'ModelHandlerGoogleInteractions',
  'ModelHandlerDeepSeek',
  'ModelHandlerXAI',
  'ModelHandlerKimi',
  'ModelHandlerDashScope',
  'ModelHandlerMiniMax',
  'ModelHandlerGLM',
  'ModelHandlerMeta',
] as const;
export type ModelHandlerCompatibilityKey =
  (typeof MODEL_HANDLER_COMPATIBILITY_KEYS)[number];
export const ModelHandlerCompatibilityKeySchema = z.enum(
  MODEL_HANDLER_COMPATIBILITY_KEYS,
);

// -------------------------------------------------------- family cores

export const StateSlicesSchema = z.object({
  runStateSnapshot: AgentRunStateSnapshotSchema,
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
  /**
   * The model the run is on, mirroring the live `ModelCell`. This is the
   * resume SSOT for model identity.
   */
  modelId: z.string().optional(),
  /** Provider-message format of the persisted messages. Absent for an
   *  untagged handler (see `modelHandlersShareConversationFormat`). */
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.optional(),
  shouldSkipCycle: z.boolean(),
  stateSlices: StateSlicesSchema.nullable(),
  /** Per-call system text for providers that do not embed it in messages. */
  systemPrompt: z.string().optional(),
  /** Validated terminal-tool result retained across interrupt and resume. */
  structured: JsonValueSchema.optional(),
});

/**
 * The message-free core of one reflection flow's shared state: every field
 * of `ReflectionFlowStateSchema` except `context`, which the agent module
 * adds. `workspaceSnapshot` and `runStateSnapshot` are top-level here:
 * reflection has no `stateSlices` and no `userChannels`.
 */
export const ReflectionSnapshotStateSchema = z.object({
  currentRound: z.int().nonnegative(),
  totalRounds: z.int().nonnegative(),

  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  outputLocation: AgentFileLocationSchema.nullable(),

  runStateSnapshot: AgentRunStateSnapshotSchema,

  roundOutputs: z.array(RoundOutputSchema),

  continueRounds: z.boolean(),
  endTurn: z.boolean(),

  /** Provider-message format used by the persisted `context` messages.
   *  Absent for an untagged handler. */
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.optional(),

  /** One-shot compile-failure feedback injected into the next round prompt. */
  compileFailureContext: z.string().optional(),

  /** Rejected compile result awaiting an explicit successful compile. */
  unresolvedCompileRejection: z.boolean().optional(),

  /**
   * Byte length of the round's raw output file after the last processed
   * response. A replayed response completes a partial write or skips one
   * already complete instead of appending its text twice.
   */
  rawOutputBytes: z.int().nonnegative().optional(),
});
