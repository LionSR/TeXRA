// Shared constants and helpers for the Claude Code CLI tool.

import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import type { StateReadFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { isClaudeCodeModel } from '@shared/schemas';
import type {
  AgentCliEffort,
  TokenUsageStats,
  ToolError,
  ToolUseLog,
  ToolCallStatus,
} from '@shared/schemas';
import { ClaudeAgentStateKey } from '@texra/shared/settingsView/integrationSettings';
import { readSettingFrom } from '@utils/config/platformSettings';
import { truncateSummary } from '@utils/text/stringUtils';

import {
  agentCliReasoning,
  resolveAgentCliModel,
  selectAgentCliModel,
  type AgentCliModelRule,
} from './agentCliModel';
import type { ModelConfig } from 'llm-zoo';

import type {
  EffortLevel,
  ModelUsage,
  SDKResultMessage,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';

const CHANNEL = 'claudeAgent';

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
 * Throws a `ToolError` for a model Claude Code cannot run.
 */
function claudeCodeRun(
  modelString: string,
  effort: AgentCliEffort | undefined,
  userEffort: AgentCliEffort,
): ClaudeCodeRun {
  const selection = selectAgentCliModel(modelString, CLAUDE_CODE_MODEL_RULE);
  const { config } = selection;
  const resolved = agentCliReasoning(selection, effort, { userEffort });
  return {
    ref: config.ref,
    model: config.id,
    effort: resolved.effort,
    thinking: claudeCodeThinking(resolved.choice.thinking, config),
    note: resolved.choice.note,
  };
}

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
      input.model ??
      (yield* readSettingFrom<string>(stores, ClaudeAgentStateKey.MODEL));
    const userEffort = yield* readSettingFrom<AgentCliEffort>(
      stores,
      ClaudeAgentStateKey.EFFORT,
    );
    const run = yield* resolveAgentCliModel(() =>
      claudeCodeRun(modelString, input.effort ?? undefined, userEffort),
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
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  cost: number,
): TokenUsageStats {
  return {
    inputTokens,
    outputTokens,
    cost,
    ...(cacheReadInputTokens > 0 && { cacheReadInputTokens }),
    ...(cacheCreationInputTokens > 0 && { cacheCreationInputTokens }),
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

/** Narrow an SDK-sourced value to a plain record, the way every built-in
 *  tool's `input` arrives per the tool-use protocol (a no-argument call still
 *  sends `{}`, never a bare primitive or `null`). */
function isToolRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Narrow a `tool_use` block's `input` to a record for storage on
 * `ToolUseLog`. A non-object payload here means the SDK sent something
 * outside the tool-use contract (every call — including no-argument ones —
 * carries a JSON object), so it's worth a loud warning rather than a cast
 * that silently misrepresents the value as a record.
 */
function toToolInputRecord(
  toolName: string,
  input: unknown,
): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  if (isToolRecord(input)) return input;
  // Direct sink write: this runs inside the SDK stream's `for await` drain
  // (one `Effect.tryPromise` in claudeAgent.ts), where no fiber is current.
  writeLogLine(
    'WARN',
    CHANNEL,
    `Claude tool "${toolName}" sent a non-object input; expected a JSON object per the tool-use protocol.`,
    { input },
  );
  return undefined;
}

/**
 * Build a tool-use log entry for a Claude `tool_use` content block.
 * Mirrors the rendering of Codex's command/file-change events while retaining
 * Claude's concrete built-in tool name.
 */
export function buildClaudeToolUseLog(params: {
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
}): ToolUseLog {
  const summarySource = describeToolInput(params.toolName, params.input);
  return {
    toolName: `claude:${params.toolName}`,
    summary: truncateSummary(summarySource, SUMMARY_MAX_LENGTH),
    input: toToolInputRecord(params.toolName, params.input),
    status: params.status,
  };
}

/**
 * Produce a short summary line for the supported built-in tools. Falls back
 * to the tool name when the input shape isn't recognized.
 */
function describeToolInput(toolName: string, input: unknown): string {
  if (!isToolRecord(input)) return toolName;
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
