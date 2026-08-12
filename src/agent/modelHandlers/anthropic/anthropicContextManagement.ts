// Type imports - agent
import { logContextManagementEvent, type AgentTrace } from '@agent/trace';
import { roundedUtilizationPercent } from '../support/contextUtilization';

// Type imports - Anthropic SDK
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaCompactionIterationUsage,
  BetaContextManagementConfig,
  BetaMessage,
  BetaUsage,
  MessageCreateParams,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  CacheControlEphemeral,
  MessageParam,
  ContentBlockParam,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/messages';

export const FILES_API_BETA: AnthropicBeta = 'files-api-2025-04-14';
export const CONTEXT_MANAGEMENT_BETA: AnthropicBeta =
  'context-management-2025-06-27';
export const COMPACTION_BETA: AnthropicBeta = 'compact-2026-01-12';
export const EXTENDED_CACHE_TTL_BETA: AnthropicBeta =
  'extended-cache-ttl-2025-04-11';

/** Compaction must be triggered at or above this minimum input token threshold. */
const MIN_COMPACTION_TRIGGER_TOKENS = 50_000;

export const SHORT_CACHE_CONTROL: CacheControlEphemeral = {
  type: 'ephemeral',
};

export const LONG_CACHE_CONTROL: CacheControlEphemeral = {
  type: 'ephemeral',
  ttl: '1h',
};

export function isLongCacheControl(cacheControl: unknown): boolean {
  if (!cacheControl || typeof cacheControl !== 'object') {
    return false;
  }
  const marker = cacheControl as Partial<CacheControlEphemeral>;
  return marker.type === 'ephemeral' && marker.ttl === '1h';
}

// Anthropic allows up to 4 cache breakpoint slots total.
const MAX_CACHE_BREAKPOINT_SLOTS = 4;

type CacheControlCompactionBlock = Extract<
  BetaContentBlockParam,
  { type: 'compaction' }
>;

const isCompactionCacheControlBlock = (
  block: ContentBlockParam | ContentBlock | BetaContentBlockParam | undefined,
): block is CacheControlCompactionBlock => {
  if (block == null || typeof block !== 'object') return false;
  return (block as { type?: string }).type === 'compaction';
};

/** Options for setting up context management configuration. */
interface ContextManagementSetupOptions {
  options: MessageCreateParams;
  contextWindow: number;
  thresholdPercent: number;
}

/** Ensures a beta flag is included in options, initializing the array if needed. */
export function ensureBeta(
  options: MessageCreateParams,
  beta: AnthropicBeta,
): void {
  options.betas ??= [];
  if (!options.betas.includes(beta)) {
    options.betas.push(beta);
  }
}

export function hasLongCacheControlMarker(messages: MessageParam[]): boolean {
  return messages.some((message) => {
    if (!Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((block) =>
      isLongCacheControl((block as { cache_control?: unknown }).cache_control),
    );
  });
}

/**
 * Sets up context management configuration for Anthropic's server-side editing.
 * Must be called before token counting so estimate options match create options.
 *
 * @returns true if a manual compaction request was consumed (caller should clear its flag)
 */
export function setupContextManagement(
  { options, contextWindow, thresholdPercent }: ContextManagementSetupOptions,
  isToolUseMode: boolean,
  isCompactionEligibleModel: boolean,
  forceCompaction: boolean,
): boolean {
  // Automatic context management is tool-use-only. A manual request also
  // enables the same native compaction path for workflow recovery.
  if (!isToolUseMode && !forceCompaction) {
    return false;
  }

  if (!isCompactionEligibleModel) {
    return false;
  }

  // Only enable context management if threshold is configured (> 0) or manually requested
  if (thresholdPercent <= 0 && !forceCompaction) {
    return false;
  }

  ensureBeta(options, CONTEXT_MANAGEMENT_BETA);

  const contextManagementEdits = [...(options.context_management?.edits ?? [])];

  if (
    !contextManagementEdits.some((edit) => edit.type === 'compact_20260112')
  ) {
    ensureBeta(options, COMPACTION_BETA);
    const compactionTriggerTokens = forceCompaction
      ? MIN_COMPACTION_TRIGGER_TOKENS
      : Math.max(
          MIN_COMPACTION_TRIGGER_TOKENS,
          Math.floor((thresholdPercent / 100) * contextWindow),
        );

    contextManagementEdits.push({
      type: 'compact_20260112',
      trigger: {
        type: 'input_tokens',
        value: compactionTriggerTokens,
      },
      pause_after_compaction: false,
    });
  }

  options.context_management = {
    ...(options.context_management ?? {}),
    edits: contextManagementEdits,
  } satisfies BetaContextManagementConfig;

  return forceCompaction;
}

export type AnthropicCompactionOutcome =
  | {
      readonly state: 'completed';
      readonly summary: string;
      readonly summaryLength: number;
      readonly content: BetaContentBlock[];
      readonly iteration?: BetaCompactionIterationUsage;
    }
  | { readonly state: 'skipped' };

/** Resolve the last usable compaction block and its matching usage iteration. */
export function resolveAnthropicCompactionOutcome(
  response: BetaMessage,
): AnthropicCompactionOutcome | undefined {
  let compactionOrdinal = -1;
  let boundary:
    | {
        readonly summary: string;
        readonly summaryLength: number;
        readonly contentIndex: number;
        readonly iterationIndex: number;
      }
    | undefined;

  for (const [contentIndex, block] of response.content.entries()) {
    if (block.type !== 'compaction') continue;
    compactionOrdinal++;
    const content = block.content;
    if (content?.trim()) {
      boundary = {
        summary: content.trim(),
        summaryLength: content.length,
        contentIndex,
        iterationIndex: compactionOrdinal,
      };
    }
  }

  if (!boundary) {
    return compactionOrdinal >= 0 ? { state: 'skipped' } : undefined;
  }

  const compactionIterations = (response.usage as BetaUsage).iterations?.filter(
    (iteration): iteration is BetaCompactionIterationUsage =>
      iteration.type === 'compaction',
  );
  return {
    state: 'completed',
    summary: boundary.summary,
    summaryLength: boundary.summaryLength,
    content: response.content.slice(boundary.contentIndex),
    iteration: compactionIterations?.[boundary.iterationIndex],
  };
}

/** Log a completed context-management outcome from an Anthropic response. */
export function logContextManagementFromResponse(
  response: BetaMessage,
  outcome: Extract<AnthropicCompactionOutcome, { state: 'completed' }>,
  contextWindow: number,
  logger: AgentTrace,
): void {
  const totalInputTokens =
    response.usage.input_tokens +
    (response.usage.cache_read_input_tokens ?? 0) +
    (response.usage.cache_creation_input_tokens ?? 0);
  const tokensBefore = outcome.iteration
    ? outcome.iteration.input_tokens +
      outcome.iteration.cache_read_input_tokens +
      outcome.iteration.cache_creation_input_tokens
    : totalInputTokens;
  const details = `Anthropic native compaction (${outcome.summaryLength.toLocaleString()} chars)`;

  logContextManagementEvent(
    logger,
    `Server-side compaction: summarized context`,
    {
      action: 'compaction',
      tokensBefore,
      tokensAfter: totalInputTokens,
      contextWindow,
      utilizationBefore: roundedUtilizationPercent(tokensBefore, contextWindow),
      utilizationAfter: roundedUtilizationPercent(totalInputTokens, contextWindow),
      details,
      summary: outcome.summary,
    },
  );
}

/**
 * Enforces the Anthropic cache breakpoint slot limit for message-level blocks.
 */
export function enforceCacheControlLimit(
  messages: MessageParam[],
  reservedSlots: number,
  cacheControl: CacheControlEphemeral,
  supportsPromptCaching: boolean,
): void {
  if (!supportsPromptCaching) {
    return;
  }

  const compactionBlocks: CacheControlCompactionBlock[] = [];

  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content) || !content.length) {
      continue;
    }

    for (const block of content) {
      if (!block || typeof block !== 'object') {
        continue;
      }

      const anyBlock = block as ContentBlockParam | BetaContentBlockParam;

      if (isCompactionCacheControlBlock(anyBlock)) {
        anyBlock.cache_control = cacheControl;
        compactionBlocks.push(anyBlock);
        continue;
      }

      if ('cache_control' in block) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }

  const availableSlots = Math.max(
    0,
    MAX_CACHE_BREAKPOINT_SLOTS - reservedSlots,
  );
  const excess = Math.max(0, compactionBlocks.length - availableSlots);
  for (const block of compactionBlocks.slice(0, excess)) {
    delete block.cache_control;
  }
}
