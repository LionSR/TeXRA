// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - agent
import type { AgentTrace } from '@agent/trace/AgentTrace';
import type { AgentPrompt } from '@agent/core/definition/AgentDataclass';
import type { TemplateVars } from '@agent/prompt/templateInputs';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { SkillCatalogEntry } from '@shared/schemas';
import type { PromptContribution, PromptSection } from '@tools/toolTable';

// Local imports - utilities
import { ensureArray } from '@utils/core';
import { renderPrompt } from '@utils/prompt';
import { loadAgentsMd } from '@utils/files/agentsMd';
import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * Instructions appended to tool-use agent prompts at open. What depends on
 * the model or the settings is rendered by each step (`stepInstructions`).
 */
const TOOL_USE_INSTRUCTIONS = `<tool_use_instructions>
Working directory: the bash tool already executes every command from {{ CWD }}. You are already in the workspace, so run commands directly with relative paths (e.g., \`ls src/\`, \`find . -name "*.tex"\`, \`cat README.md\`). Scope file searches to \`.\` or a subdirectory, or use the glob/grep tools.
Explicit user constraints override general workflow guidance elsewhere in the agent prompt. If the user forbids memory, planning, todos, file access, or a tool, do not use it. Report any resulting conflict instead.

Prefer using tools over asking the user to take manual actions.
If you say you will perform an action, immediately call the corresponding tool.
Do only what the task requires. Do not refactor, restructure, or "improve" material beyond it. When the user describes a problem without asking for a change, deliver your assessment before editing files.
When an approved plan or autonomous objective is active, work toward it end to end. Keep going and verify against real evidence rather than pausing to confirm each step or summarize progress. Stop only when it is verifiably done or you are genuinely blocked on something only the user can provide.
In replies, lead with the outcome. Keep responses short by being selective about what to include, not by compressing the writing.
Never mention tool names when speaking to the user.
For math in responses, use $...$ or \\(...\\) for inline and $$...$$ or \\[...\\] for display math. Wrap LaTeX environments like align or gather inside $$...$$ (e.g., $$\\begin{align}...\\end{align}$$) so they render correctly.
</tool_use_instructions>`;

/**
 * The tool-call mechanics are provider-gated: OpenAI-compatible providers
 * (DeepSeek, Kimi, GLM, MiniMax, …) need the schema/JSON/multi_tool_use
 * guardrails and the sequential-call constraint (Google/DeepSeek thought-
 * signature batching assumes ordered follow-ups). Anthropic models handle
 * parallel tool calls natively, so they get the parallel encouragement
 * instead of the weak-model boilerplate.
 */
const ANTHROPIC_TOOL_CALLS = `Independent tool calls may be issued together in one response. Sequence only calls that depend on an earlier result.
Do not create excessive markdown files or documentation unless explicitly requested.`;
const SEQUENTIAL_TOOL_CALLS = `When using a tool, follow the JSON schema exactly and include all required properties.
Always produce valid JSON when calling a tool.
Do not call tools that are not provided or any multi_tool_use variants.
Call tools sequentially and wait for the output before calling another.`;

/**
 * The system text a step adds after the run's recorded prompt: the tool-call
 * mechanics of the step's model and the configured bibliography, the skills
 * the step lists, then each pinned plugin's section, in plugin id order. It
 * is built from the step (its model, settings, offered tools and pinned
 * contributors) and the catalog the run recorded at open, so a model switch
 * or a setting change reaches the next request, and a resume rebuilds it.
 */
export function stepInstructions(
  prompt: ReadonlyMap<string, PromptContribution>,
  skills: readonly SkillCatalogEntry[],
  ctx: Parameters<PromptSection>[0],
): string {
  return [
    ctx.isAnthropic ? ANTHROPIC_TOOL_CALLS : SEQUENTIAL_TOOL_CALLS,
    ...(ctx.bibPath
      ? [
          `The default bibliography file is ${ctx.bibPath}. You can grep or read this file to search for citations and references.`,
        ]
      : []),
    ...(skills.length > 0
      ? [
          `<available_skills>\nThe following imported skills are available. If one is relevant, inspect its SKILL.md at the listed path before applying it.\n${skills.map(({ text }) => text).join('\n')}\n</available_skills>`,
        ]
      : []),
    ...[...prompt.values()].flatMap(({ section }) => section?.(ctx) || []),
  ].join('\n');
}

/**
 * Combine the base system prompt with the project's `AGENTS.md`, if any.
 *
 * @param systemPrompt Base system prompt template
 * @param userVars Variables for template rendering
 * @param workspace The run's workspace root, whose `AGENTS.md` applies
 * @returns Full system prompt string
 */
export const getSystemPromptWithRules = Effect.fn('prompt.systemWithRules')(
  function* (
    systemPrompt: string,
    userVars: TemplateVars,
    workspace: string | undefined,
  ): Effect.fn.Return<string, Error, FileSystem.FileSystem> {
    const parts = [yield* renderPrompt(systemPrompt, userVars)];

    const instructions = yield* loadAgentsMd(workspace);
    if (instructions) parts.push(instructions);

    // Append attached memories (read-only context from orchestrator)
    const attachedMemories = userVars.ATTACHED_MEMORIES;
    if (typeof attachedMemories === 'string' && attachedMemories) {
      parts.push(attachedMemories);
    }

    return parts.join('\n');
  },
);

/** The rendered round-0 prompts: system prompt, user prefix, and initial request. */
interface InitialPrompts {
  systemPrompt: string;
  userPrefix: string;
  userRequest: string;
}

/**
 * Centralises prompt construction logic for multi-round agents.
 *
 * @remarks
 * The builder renders all prompts lazily so callers can defer work until the
 * relevant conversation stage. Rounds use zero-based indexing where round 0
 * is the initial prompt and subsequent rounds continue from the array.
 *
 * @example
 * ```ts
 * const builder = new PromptBuilder(prompt, vars, workspace, logger);
 * const initial = yield* builder.buildInitialPrompts();
 * const firstRoundRequest = yield* builder.buildUserRequest(1);
 * ```
 */
export class PromptBuilder {
  constructor(
    private readonly agentPrompt: AgentPrompt,
    private readonly userVars: TemplateVars,
    /** The run's workspace root, whose `AGENTS.md` the system prompt gets. */
    private readonly workspace: string | undefined,
    private readonly logger?: AgentTrace,
  ) {}

  /**
   * Render the initial system, prefix, and request prompts for round 0.
   */
  public buildInitialPrompts(): Effect.Effect<
    InitialPrompts,
    Error,
    FileSystem.FileSystem
  > {
    return Effect.all(
      [
        getSystemPromptWithRules(
          this.agentPrompt.systemPrompt,
          this.userVars,
          this.workspace,
        ),
        this.buildUserRequest(0),
        renderPrompt(this.agentPrompt.userPrefix, this.userVars),
      ],
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.map(([systemPrompt, userRequest, userPrefix]) => ({
        systemPrompt,
        userPrefix,
        userRequest,
      })),
    );
  }

  /**
   * Render the user request for the supplied round.
   *
   * @param currRound Zero-based round number (round 0 selects the initial template)
   * @remarks Rounds beyond the configured templates fall back to the second template (index 1).
   */
  public buildUserRequest(currRound: number): Effect.Effect<string, Error> {
    const template = this.getRoundTemplate(currRound);

    if (!template) {
      this.logger?.warn(
        currRound === 0
          ? 'No initial user request configured. Returning empty prompt.'
          : `No prompt configured for round ${currRound}. Returning empty prompt.`,
      );
      return Effect.succeed('');
    }

    return renderPrompt(template, this.userVars);
  }

  private getRoundTemplate(currRound: number): string | undefined {
    const { userRequest } = this.agentPrompt;
    const templates = userRequest ? ensureArray(userRequest) : [];

    const round = Math.max(0, currRound);
    if (round < templates.length) return templates[round];

    // For rounds beyond configured templates, fall back to the last template.
    // Multi-template agents reuse templates[1] (the revision prompt) for all
    // subsequent rounds. Single-template agents reuse templates[0].
    if (round > 0 && templates.length >= 1) {
      const fallbackIndex = Math.min(1, templates.length - 1);
      this.logger?.debug(
        `No prompt configured for round ${currRound}. Reusing template at index ${fallbackIndex}.`,
      );
      return templates[fallbackIndex];
    }

    return undefined;
  }
}

export const buildInitialToolUsePrompts = Effect.fn('prompt.initialToolUse')(
  function* (
    agentPrompt: AgentPrompt,
    userVars: TemplateVars,
    logger: AgentTrace | undefined,
    options: {
      /** The run's workspace root: its `AGENTS.md` and `<workspace_info>`. */
      workspace: string | undefined;
      /** The same session's setting slots, for the `<workspace_info>` git reads. */
      settings: SettingsStores;
    },
  ): Effect.fn.Return<
    InitialPrompts & { instructionSuffix: string },
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  > {
    const builder = new PromptBuilder(
      agentPrompt,
      userVars,
      options.workspace,
      logger,
    );
    const initial = yield* builder.buildInitialPrompts();

    // The instruction suffix: tool-use instructions and workspace info. What
    // each step's plugins add is appended per request (`stepInstructions`).
    const suffixParts = [
      TOOL_USE_INSTRUCTIONS,
      yield* buildWorkspaceInfoBlock(options.workspace, options.settings),
    ];

    return {
      ...initial,
      instructionSuffix: yield* renderPrompt(suffixParts.join('\n'), userVars),
    };
  },
);
