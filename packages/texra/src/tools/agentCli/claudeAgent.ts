/**
 * Claude Code CLI tool — spin off a Claude Code agent via @anthropic-ai/claude-agent-sdk.
 *
 * Mirrors the codex / `agent` model: every call is async, and every call
 * is one turn, run as one child run that ends with its result delivered as
 * a follow-up to the parent. Without a session_id, a new Claude Code
 * session is started. With a session_id, the prompt continues that session
 * through the SDK's `resume:` option. With fork_session, it instead starts
 * a new session from the selected session's state.
 *
 * Authentication: the SDK spawns the Claude Code CLI as a subprocess, which
 * picks up whichever auth the user has configured:
 *   - ANTHROPIC_API_KEY env var (or the Anthropic key TeXRA stores)
 *   - CLAUDE_CODE_OAUTH_TOKEN env var (long-lived OAuth token from
 *     `claude setup-token`)
 *   - OAuth session from `claude login` (Pro/Max subscription)
 *   - Bedrock / Vertex (configured via CLI/env vars)
 *
 * Requires the native `claude` CLI, checked in claudeAgentPlugin.ts.
 */

// Third-party imports
import { Effect, Schema, type Scope, Stream } from 'effect';
import { ChildRuns, ToolContext } from '@texra-ai/harness/plugins';

// Local imports
import { MESSAGE_TYPES, type ToolUseLog } from '@texra-ai/harness/schemas';
import {
  ToolError,
  type AgentTrace,
  defineTool,
  optionalInput,
} from '@texra-ai/harness/plugins';
import {
  AgentCliEffortSchema,
  ClaudeAgentModelSchema,
} from '@texra/shared/agentCliSettings';
import { buildAgentWorkspaceOptions } from '@texra/tools/agentCli/agentWorkspaceOptions';

// Local file imports
import { ClaudeBackgroundTaskTracker } from './claudeAgentBackgroundTasks';
import {
  importClaudeAgentSdk,
  findClaudeBinaryPath,
} from './claudeAgentImport';
import { buildClaudeAgentEnv } from './claudeAgentConfig';
import { ClaudeAgentSessions } from './agentCliSessionStores';
import {
  agentCliTool,
  StreamedToolCards,
  asToolError,
  type AgentCliTurn,
} from './agentCliShared';
import {
  buildClaudeToolUseLog,
  claudeResultUsage,
  CLAUDE_AGENT_NAME,
  readClaudeCodeRun,
} from './claudeAgentShared';

// Third-party type imports (import/order places these after local imports)
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

// ============================================================================
// Schema
// ============================================================================

const ClaudeAgentInputSchema = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      'Instruction for the Claude Code agent. For a new session, describe the task. For a resume (session_id set), describe the follow-up.',
  }),
  model: optionalInput(
    Schema.String,
    `Claude model reference, optionally with an effort suffix (e.g. 'anthropic/claude-opus-5-5' or 'anthropic/claude-opus-5-5@high'). Any non-retired Anthropic model; current ones: ${ClaudeAgentModelSchema.literals.join(', ')}. Defaults to the user-configured model.`,
  ),
  effort: optionalInput(
    AgentCliEffortSchema,
    "Reasoning effort; overrides the model's @effort suffix. Defaults to the user-configured effort (medium unless changed). A level the model lacks becomes the nearest one it has.",
  ),
  session_id: optionalInput(
    Schema.NonEmptyString,
    'Continue an existing Claude Code session with a follow-up instruction, as its next turn. A session whose turn is still running refuses another until that turn is delivered.',
  ),
  fork_session: optionalInput(
    Schema.Boolean,
    'When true, branch from session_id into a new Claude session and leave the original session unchanged. Defaults to false.',
  ),
}).check(
  Schema.makeFilter((input) =>
    input.fork_session !== true || input.session_id != null
      ? undefined
      : { path: ['fork_session'], issue: 'fork_session requires session_id' },
  ),
);

type ClaudeAgentInput = typeof ClaudeAgentInputSchema.Type;

/** The two of the SDK's permission modes a launch runs under. */
type ClaudePermissionMode = Extract<
  PermissionMode,
  'acceptEdits' | 'bypassPermissions'
>;

// ============================================================================
// Streamed turn — drains the SDK's async generator into log entries and the
// turn its follow-up delivers.
// ============================================================================

/** The SDK's options for one turn, all but the abort controller the stream
 *  owns. */
type ClaudeTurnOptions = Omit<ClaudeAgentSdkOptions, 'abortController'>;

const runStreamedTurn = Effect.fn('runStreamedTurn')(function* (params: {
  prompt: string;
  logger: AgentTrace;
  options: ClaudeTurnOptions;
}): Effect.fn.Return<AgentCliTurn, ToolError, Scope.Scope> {
  const { logger, prompt, options } = params;
  logger.info(prompt, { messageType: MESSAGE_TYPES.USER_MESSAGE });

  const query = yield* importClaudeAgentSdk().pipe(
    Effect.mapError(asToolError),
  );

  // The SDK takes a controller, not a signal: this one exists only at that
  // boundary, aborted when the turn is interrupted.
  const abortController = new AbortController();
  const sdkOptions: ClaudeAgentSdkOptions = { ...options, abortController };

  const responseParts: string[] = [];
  const toolCards = yield* StreamedToolCards.make(logger);
  const backgroundTasks = new ClaudeBackgroundTaskTracker(logger);
  let usage: AgentCliTurn['usage'] = null;
  let sessionId: string | undefined;
  let totalCostUsd: number | undefined;
  let isError = false;
  let errorMessage: string | undefined;

  const onMessage = (raw: SDKMessage): void => {
    if ('session_id' in raw && raw.session_id) sessionId = raw.session_id;
    switch (raw.type) {
      case 'assistant':
        handleAssistantBlocks(
          raw.message.content,
          logger,
          toolCards,
          responseParts,
        );
        break;
      case 'user':
        if (Array.isArray(raw.message.content)) {
          handleToolResults(raw.message.content, toolCards);
        }
        break;
      case 'result':
        usage = claudeResultUsage(raw);
        totalCostUsd = raw.total_cost_usd;
        if (raw.subtype === 'success') {
          if (typeof raw.result === 'string' && raw.result.trim() !== '')
            responseParts.push(raw.result);
        } else {
          isError = true;
          errorMessage =
            raw.errors?.join('\n') || raw.subtype || 'Claude Code error';
        }
        break;
      case 'system':
        switch (raw.subtype) {
          case 'init':
            logger.info(`Claude session ${raw.session_id} started`);
            break;
          case 'background_tasks_changed':
            backgroundTasks.replace(raw.tasks);
            break;
        }
        break;
    }
  };
  yield* Stream.unwrap(
    Effect.try({
      try: () =>
        Stream.fromAsyncIterable(
          query({ prompt, options: sdkOptions }),
          asToolError,
        ),
      catch: asToolError,
    }),
  ).pipe(
    Stream.runForEach((raw) =>
      Effect.try({ try: () => onMessage(raw), catch: asToolError }),
    ),
    Effect.onInterrupt(() => Effect.sync(() => abortController.abort())),
    Effect.ensuring(Effect.sync(() => backgroundTasks.finish())),
  );

  if (options.forkSession && (!sessionId || sessionId === options.resume)) {
    isError = true;
    errorMessage = [
      errorMessage,
      'Claude Code fork did not create a distinct session',
    ]
      .filter(
        (part): part is string =>
          typeof part === 'string' && part.trim() !== '',
      )
      .join('\n');
  }

  return {
    response: responseParts.join('\n\n'),
    usage,
    attributes: sessionId ? [{ name: 'session-id', value: sessionId }] : [],
    ...(typeof totalCostUsd === 'number' &&
      totalCostUsd > 0 && {
        lines: [`<cost-usd>${totalCostUsd.toFixed(4)}</cost-usd>`],
      }),
    ...(isError && {
      failure:
        errorMessage || 'Claude Code reported a failed turn without throwing.',
    }),
  };
}, Effect.scoped);

function handleAssistantBlocks(
  blocks: SDKAssistantMessage['message']['content'],
  logger: AgentTrace,
  cards: StreamedToolCards,
  responseParts: string[],
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.trim() !== '') {
          logger.info(block.text, {
            messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          });
          responseParts.push(block.text);
        }
        break;
      case 'thinking':
        if (
          typeof block.thinking === 'string' &&
          block.thinking.trim() !== ''
        ) {
          logger.info(block.thinking, { messageType: MESSAGE_TYPES.THINKING });
        }
        break;
      case 'tool_use': {
        if (typeof block.name !== 'string') break;
        if (typeof block.id !== 'string' || block.id.length === 0) break;
        const { log, violation } = buildClaudeToolUseLog({
          toolName: block.name,
          input: block.input,
          status: 'in_progress',
        });
        // The run's own trace: this runs inside the SDK stream's drain,
        // where no fiber is current.
        if (violation !== undefined) logger.warn(violation);
        cards.open(block.id, log);
        break;
      }
    }
  }
}

function handleToolResults(
  blocks: Exclude<SDKUserMessage['message']['content'], string>,
  cards: StreamedToolCards,
): void {
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    if (typeof id !== 'string') continue;
    const card = cards.get(id);
    if (!card) continue;

    const isError = block.is_error === true;
    const update: Partial<ToolUseLog> = {
      ...(block.content !== undefined && { output: block.content }),
      ...(isError && {
        error: extractToolErrorMessage(block.content) ?? 'Tool error',
      }),
    };
    cards.close(id, {
      ...card.log,
      ...update,
      status: isError ? 'failed' : 'completed',
    });
  }
}

function extractToolErrorMessage(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block != null && typeof block === 'object' && 'text' in block) {
      const { text } = block;
      if (typeof text === 'string') return text;
    }
  }
  return undefined;
}

// ============================================================================
// Tool
// ============================================================================

/** Prepare a launch: the model, the permission mode the run's approval
 *  policy grants, the environment and the binary, and the SDK options the
 *  turn runs with. */
const prepareLaunch = Effect.fn('claudeAgent.prepareLaunch')(function* (
  input: ClaudeAgentInput,
) {
  const { roots, workingDirectory: parentWorkingDirectory } =
    (yield* ToolContext).env;
  // File edits auto-accepted when a person approved the launch; every
  // permission bypassed when the run's work is auto-approved.
  const autoApproved = yield* (yield* ChildRuns).autoApproved.pipe(
    Effect.mapError(asToolError),
  );
  const permissionMode: ClaudePermissionMode = autoApproved
    ? 'bypassPermissions'
    : 'acceptEdits';
  const claudeRun = yield* readClaudeCodeRun(roots, input).pipe(
    Effect.catchTag('StateReadFailed', (error) =>
      Effect.fail(asToolError(error)),
    ),
  );
  // Mirrors codex so subagents can see the project: a call from inside the
  // workspace runs in that directory with read access to the workspace root
  // for sibling files; an out-of-workspace cwd runs isolated. The SDK's
  // `Options` names these `cwd` / `additionalDirectories`, unlike codex.
  const { workingDirectory, additionalDirectories } =
    buildAgentWorkspaceOptions(roots.workspace, parentWorkingDirectory);
  // The env block reads the process environment and `Secrets`: no workspace.
  const env = yield* buildClaudeAgentEnv().pipe(
    Effect.mapError(
      (failure) =>
        new ToolError(
          `Could not read the managed Anthropic API key: ${failure.message}`,
          { cause: failure },
        ),
    ),
  );
  const pathToClaudeCodeExecutable = yield* findClaudeBinaryPath().pipe(
    Effect.mapError(
      (failure) =>
        new ToolError(
          `Could not locate the Claude Code binary: ${failure.message}`,
          { cause: failure },
        ),
    ),
  );
  const options: ClaudeTurnOptions = {
    model: claudeRun.model,
    permissionMode,
    env,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    ...(claudeRun.effort ? { effort: claudeRun.effort } : {}),
    ...(claudeRun.thinking ? { thinking: claudeRun.thinking } : {}),
    ...(permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(workingDirectory ? { cwd: workingDirectory } : {}),
    ...(additionalDirectories?.length ? { additionalDirectories } : {}),
    ...(input.session_id ? { resume: input.session_id } : {}),
    ...(input.fork_session === true ? { forkSession: true } : {}),
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
  };
  return {
    modelRef: claudeRun.ref,
    launchedLine: `Claude Code agent launched (model: ${claudeRun.ref}, effort: ${claudeRun.effort ?? 'none'}, permission: ${permissionMode}).${claudeRun.note ? ` ${claudeRun.note}` : ''}`,
    turn: (logger: AgentTrace) =>
      runStreamedTurn({ prompt: input.prompt, logger, options }),
  };
});

export const ClaudeAgentTool = defineTool({
  name: CLAUDE_AGENT_NAME,
  description:
    'Spin off a Claude Code agent (via @anthropic-ai/claude-agent-sdk) to perform code analysis, generation, or research. ' +
    "The agent runs the native `claude` binary locally and can read files, run commands, and make edits within the permissions this run's approval policy grants: file edits auto-accepted when the launch was approved, every permission bypassed under Auto-approve or an all-agent-work grant. " +
    'Auth: ANTHROPIC_API_KEY (the Anthropic key TeXRA stores, or the env var), CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`), or `claude login` OAuth session. ' +
    'Always async: returns immediately with a run ID; each turn is delivered back as a follow-up message (including the session_id). ' +
    'Pass session_id on a later call to continue that session with a follow-up, one turn per call. ' +
    'Set fork_session to branch from that session while leaving the original unchanged. Choose claude_code for coding tasks that benefit from a separate Anthropic Claude Code agent. It runs in the working directory of the calling agent, with independent file editing, search, and shell access, async and multi-turn like `agent`; it takes no directory argument, so give parallel coders disjoint files to edit. codex and claude_code are both independent sandboxed coders distinct from the in-process `agent` specialists. Prefer whichever vendor fits the task.',
  schema: ClaudeAgentInputSchema,
  guard: {
    command: {
      text: (input: ClaudeAgentInput) =>
        `[${CLAUDE_AGENT_NAME}] ${input.prompt}`,
    },
  },
  execute: agentCliTool({
    name: CLAUDE_AGENT_NAME,
    family: 'claude-agent',
    label: 'Claude Code CLI',
    threadLabel: 'Claude Code session',
    idField: 'session_id',
    store: ClaudeAgentSessions,
    // A fork only reads its source session: it claims nothing.
    resumeId: (input: ClaudeAgentInput) =>
      input.fork_session === true ? undefined : (input.session_id ?? undefined),
    prepare: prepareLaunch,
  }),
});
