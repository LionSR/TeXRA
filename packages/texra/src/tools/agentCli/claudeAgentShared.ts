// Shared constants and helpers for the Claude Code CLI tool.

import {
  truncateSummary,
  type TokenUsageStats,
  type ToolUseLog,
  type ToolCallStatus,
} from '@texra-ai/harness/schemas';
import { Effect, Predicate } from 'effect';

import { isClaudeCodeModel } from '@texra/shared/agentCliSettings';
import type { AgentCliEffort } from '@texra/shared/agentCliSettings';

import {
  agentCliReasoning,
  selectAgentCliModel,
  type AgentCliModelRule,
} from './agentCliModel';
import {
  type ToolError,
  withLogChannel,
  Settings,
  type SettingsStores,
} from '@texra-ai/harness/plugins';
import type { StateReadFailed } from '@texra-ai/harness/host';
import type { ModelConfig } from '@texra-ai/llm';

import type {
  EffortLevel,
  ModelUsage,
  SDKResultMessage,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_AGENT_EFFORT_SETTING,
  CLAUDE_AGENT_MODEL_SETTING,
} from '@texra/shared/settings/integrationSettings';

/**
 * Compile-time guard: the agent CLI effort vocabulary in `@shared` (the one
 * the settings UI, the IPC schema, and the tool runtime share) and the SDK's
 * `EffortLevel` union must stay synchronized in both directions. If the SDK
 * adds or removes an effort level, this line produces a type error so
 * `AgentCliEffortSchema` and the SDK type are reviewed together.
 */
type _AssertExact<T extends true> = T;
type _IsExact<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

type _EffortLevelsAligned = _AssertExact<
  _IsExact<EffortLevel, `${AgentCliEffort}`>
>;

export const CLAUDE_AGENT_NAME = 'claude_code';

const CLAUDE_CODE_MODEL_RULE: AgentCliModelRule = {
  cli: 'Claude Code',
  eligible: isClaudeCodeModel,
  requirement: 'a non-retired Anthropic model',
};

/** What one Claude Code session runs: the SDK's model, effort and thinking. */
export interface ClaudeCodeRun {
  /** The model's llm-zoo reference, the run's model label. */
  readonly ref: string;
  /** The API model ID the SDK takes. */
  readonly model: string;
  readonly effort: EffortLevel | undefined;
  readonly thinking: ThinkingConfig | undefined;
  /** Why the effort differs from the one asked for, for the run's log. */
  readonly note: string | undefined;
}

/** Thinking off says so; a budget-sized model keeps Claude Code's default; otherwise adaptive. */
function claudeCodeThinking(
  thinking: boolean,
  config: Pick<ModelConfig, 'reasoning'>,
): ThinkingConfig | undefined {
  if (!thinking) return { type: 'disabled' };
  if (config.reasoning?.budget === true) return undefined;
  return { type: 'adaptive' };
}

/**
 * Resolve a Claude Code model string (`anthropic/<id>[@effort]`) and the
 * call's effort through the reasoning policy. Adaptive thinking is sent when
 * the model thinks on this request and sizes thinking adaptively; a
 * budget-sized model (e.g. Haiku 4.5) rejects `adaptive`, so it keeps Claude
 * Code's own default. A request with thinking off (`@none`) says so.
 * Fails with a `ToolError` for a model Claude Code cannot run.
 */
const claudeCodeRun = Effect.fn('claudeAgent.claudeCodeRun')(function* (
  modelString: string,
  effort: AgentCliEffort | undefined,
  userEffort: AgentCliEffort,
): Effect.fn.Return<ClaudeCodeRun, ToolError> {
  const selection = yield* selectAgentCliModel(
    modelString,
    CLAUDE_CODE_MODEL_RULE,
  );
  const { config } = selection;
  const resolved = yield* agentCliReasoning(selection, effort, { userEffort });
  return {
    ref: config.ref,
    model: config.id,
    effort: resolved.effort,
    thinking: claudeCodeThinking(resolved.choice.thinking, config),
    note: resolved.choice.note,
  };
});

/**
 * The run a Claude Code call asks for: its own model and effort, else the
 * user's settings. A snapped effort's note goes to the log.
 */
export const readClaudeCodeRun = Effect.fn('claudeAgent.readClaudeCodeRun')(
  function* (
    stores: SettingsStores,
    input: {
      readonly model?: string | null;
      readonly effort?: AgentCliEffort | null;
    },
  ): Effect.fn.Return<ClaudeCodeRun, ToolError | StateReadFailed> {
    const modelString =
      input.model ?? (yield* Settings.get(stores, CLAUDE_AGENT_MODEL_SETTING));
    const userEffort = yield* Settings.get(stores, CLAUDE_AGENT_EFFORT_SETTING);
    const run = yield* claudeCodeRun(
      modelString,
      input.effort ?? undefined,
      userEffort,
    );
    if (run.note) {
      yield* Effect.logInfo(run.note).pipe(withLogChannel(CLAUDE_AGENT_NAME));
    }
    return run;
  },
);

const SUMMARY_MAX_LENGTH = 60;

/** The Claude counts in the one usage shape; zero cache counts are omitted. */
function claudeUsageStats(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheWriteTokens: number,
  cost: number,
): TokenUsageStats {
  return {
    inputTokens,
    outputTokens,
    cost,
    ...(cachedInputTokens > 0 && { cachedInputTokens }),
    ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
  };
}

/**
 * A turn's spend, read once from the SDK's result message: the authoritative
 * per-model totals (main loop plus nested model calls), or the main-loop
 * counts from a result that carries no per-model totals.
 */
export function claudeResultUsage(
  result: Pick<SDKResultMessage, 'modelUsage' | 'usage'>,
): TokenUsageStats | null {
  if (result.modelUsage == null) {
    const { usage } = result;
    return usage
      ? claudeUsageStats(
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          0,
        )
      : null;
  }
  const models = Object.values(result.modelUsage);
  if (models.length === 0) return null;

  const sum = (pick: (model: ModelUsage) => number): number =>
    models.reduce((total, model) => total + pick(model), 0);
  return claudeUsageStats(
    sum((model) => model.inputTokens),
    sum((model) => model.outputTokens),
    sum((model) => model.cacheReadInputTokens),
    sum((model) => model.cacheCreationInputTokens),
    sum((model) => model.costUSD),
  );
}

/**
 * Build a tool-use log entry for a Claude `tool_use` content block.
 * Mirrors the rendering of Codex's command/file-change events while retaining
 * Claude's concrete built-in tool name. The entry stores the input only as
 * a record: every call, including a no-argument one, carries a JSON object
 * per the tool-use protocol, so a non-object input is the SDK breaking that
 * contract, which `violation` says for the caller to report rather than a
 * cast that silently misrepresents the value as a record.
 */
export function buildClaudeToolUseLog(params: {
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
}): { readonly log: ToolUseLog; readonly violation?: string } {
  const { toolName, input } = params;
  const log: ToolUseLog = {
    toolName: `claude:${toolName}`,
    summary: truncateSummary(
      describeToolInput(toolName, input),
      SUMMARY_MAX_LENGTH,
    ),
    input: Predicate.isObject(input) ? input : undefined,
    status: params.status,
  };
  return input === undefined || Predicate.isObject(input)
    ? { log }
    : {
        log,
        violation: `Claude tool "${toolName}" sent a non-object input (${typeof input}); expected a JSON object per the tool-use protocol.`,
      };
}

/**
 * Produce a short summary line for the supported built-in tools. Falls back
 * to the tool name when the input shape isn't recognized.
 */
function describeToolInput(toolName: string, input: unknown): string {
  if (!Predicate.isObject(input)) return toolName;
  const record = input;

  switch (toolName) {
    case 'Bash':
      if (typeof record.command === 'string') return record.command;
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      if (typeof record.file_path === 'string') {
        return `${toolName} ${record.file_path}`;
      }
      break;
    case 'Glob':
    case 'Grep':
      if (typeof record.pattern === 'string') {
        return `${toolName} ${record.pattern}`;
      }
      break;
    case 'WebFetch':
      if (typeof record.url === 'string') return `WebFetch ${record.url}`;
      break;
    case 'WebSearch':
      if (typeof record.query === 'string') return `WebSearch ${record.query}`;
      break;
    case 'TaskCreate':
      if (typeof record.subject === 'string') {
        return `Create task: ${record.subject}`;
      }
      break;
    case 'TaskUpdate': {
      const task = [record.subject, record.taskId].find(
        (value): value is string => typeof value === 'string',
      );
      if (task) {
        return typeof record.status === 'string'
          ? `Update task: ${task} → ${record.status}`
          : `Update task: ${task}`;
      }
      break;
    }
    case 'TaskGet':
      if (typeof record.taskId === 'string') {
        return `Get task: ${record.taskId}`;
      }
      break;
    case 'TaskList':
      return 'List tasks';
    case 'Agent':
      if (typeof record.description === 'string') {
        return `Agent ${record.description}`;
      }
      break;
  }
  return toolName;
}
