// Local imports - agent
import type { AgentTrace } from '@agent/trace/AgentTrace';
import type { AgentPrompt } from '@agent/core/definition/AgentDataclass';

// Local imports - utilities
import { ensureArray } from '@utils/core';
import { renderPrompt } from '@utils/prompt';
import { loadTexraRules } from '@utils/files/rulesUtils';
import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';

/**
 * Instructions appended to tool-use agent prompts.
 *
 * The tool-call mechanics block is provider-gated: OpenAI-compatible providers
 * (DeepSeek, Kimi, GLM, MiniMax, …) need the schema/JSON/multi_tool_use
 * guardrails and the sequential-call constraint (Google/DeepSeek thought-
 * signature batching assumes ordered follow-ups). Anthropic models handle
 * parallel tool calls natively — the handler batches parallel results into the
 * canonical single-assistant/single-user shape — so they get the parallel
 * encouragement instead of the weak-model boilerplate.
 */
const TOOL_USE_INSTRUCTIONS = `<tool_use_instructions>
Working directory: the bash tool already executes every command from {{ CWD }}. You are already in the workspace, so run commands directly with relative paths (e.g., \`ls src/\`, \`find . -name "*.tex"\`, \`cat README.md\`). Scope file searches to \`.\` or a subdirectory, or use the glob/grep tools.
Explicit user constraints override general workflow guidance elsewhere in the agent prompt. If the user forbids memory, planning, todos, file access, or a tool, do not use it. Report any resulting conflict instead.

Prefer using tools over asking the user to take manual actions.
If you say you will perform an action, immediately call the corresponding tool.
{% if IS_ANTHROPIC_MODEL %}Independent tool calls may be issued together in one response. Sequence only calls that depend on an earlier result.
{% else %}When using a tool, follow the JSON schema exactly and include all required properties.
Always produce valid JSON when calling a tool.
Do not call tools that are not provided or any multi_tool_use variants.
Call tools sequentially and wait for the output before calling another.
{% endif %}Do only what the task requires. Do not refactor, restructure, or "improve" material beyond it. When the user describes a problem without asking for a change, deliver your assessment before editing files.
When an approved plan or autonomous objective is active, work toward it end to end. Keep going and verify against real evidence rather than pausing to confirm each step or summarize progress. Stop only when it is verifiably done or you are genuinely blocked on something only the user can provide.
In replies, lead with the outcome. Keep responses short by being selective about what to include, not by compressing the writing.
Never mention tool names when speaking to the user.
For math in responses, use $...$ or \\(...\\) for inline and $$...$$ or \\[...\\] for display math. Wrap LaTeX environments like align or gather inside $$...$$ (e.g., $$\\begin{align}...\\end{align}$$) so they render correctly.
{% if DEFAULT_BIB_PATH %}The default bibliography file is {{ DEFAULT_BIB_PATH }}. You can grep or read this file to search for citations and references.{% endif %}
{% if AVAILABLE_SKILLS %}
<available_skills>
The following imported skills are available. If one is relevant, inspect its SKILL.md at the listed path before applying it.
{{ AVAILABLE_SKILLS }}
</available_skills>
{% endif %}
</tool_use_instructions>`;

/** Base memory instructions for all agents with memory enabled. */
const MEMORY_TOOL_INSTRUCTIONS = `<memory_tool_instructions>
Pinned memories are always loaded unless the user forbids memory use. At session start, \`view\` the \`/memories\` directory to find entries marked [pinned]. If the listing is truncated, continue until you have seen every [pinned] entry. Then \`view\` each pinned file so its content applies, regardless of how self-contained the request looks. Pinned entries are the core reusable insights (techniques, strategies, pitfalls) accumulated across sessions. The directory listing alone does not load their content. Beyond pinned entries, use memory when the request may depend on prior sessions, durable user preferences, or shared agent context. For a self-contained request, do not read unpinned memory files or write memory merely because the tool is available. Listing the directory is still appropriate because it is needed to find pinned entries.

Your memory persists across conversations. When memory is in play, record durable progress, decisions, and user preferences (writing style, conventions, formatting, workflow). Keep the folder current and organized by updating, renaming, or deleting files rather than duplicating them. Do not store what the workspace files already state. When project context, coding patterns, or conventions are relevant to the task and git is available, look into git history (commit messages, PR descriptions, recent changes) to understand them. Use \`pin\` only for long-term reusable insights, never task-specific progress notes. Use \`unpin\` for entries that no longer earn their place.
</memory_tool_instructions>`;

/** Memory instructions for orchestrators that launch subagents. */
const ORCHESTRATOR_MEMORY_INSTRUCTIONS = `<orchestrator_memory_protocol>
The /memories directory is shared with all subagents you launch. Subagents can read and write the same files. Use this for persistent context that should survive across conversations. Do not use it as a substitute for subagent result delivery because subagents report back automatically via follow-up messages. Good uses include project conventions, user preferences, and research bibliographies that build up over time.

For continuation or delegation-heavy work, consult relevant memories instead of rediscovering context. Record reusable intelligence: what approaches worked or failed and why, project structure and conventions you discovered, user preferences revealed through corrections or rejections, and effective problem-solving strategies.
</orchestrator_memory_protocol>`;

/** Memory instructions for subagents launched by an orchestrator. */
const SUBAGENT_MEMORY_INSTRUCTIONS = `<subagent_memory_protocol>
The /memories directory is shared with the orchestrator and other subagents. Check it when your delegated task may depend on context from prior sessions or sibling agents. Write to memory for information that should persist beyond this session (e.g., discovered conventions, useful references). Your primary results should go in your response, not in memory.
</subagent_memory_protocol>`;

/**
 * Combine the base system prompt with optional rules from `.texrarules`.
 *
 * @param systemPrompt Base system prompt template
 * @param userVars Variables for template rendering
 * @returns Full system prompt string
 */
export async function getSystemPromptWithRules(
  systemPrompt: string,
  userVars: Record<string, unknown>,
): Promise<string> {
  const basePrompt = await renderPrompt(systemPrompt, userVars);
  const parts = [basePrompt];

  const rules = await loadTexraRules();
  if (rules) parts.push(rules);

  // Append attached memories (read-only context from orchestrator)
  const attachedMemories = userVars.ATTACHED_MEMORIES;
  if (typeof attachedMemories === 'string' && attachedMemories) {
    parts.push(attachedMemories);
  }

  return parts.join('\n');
}

/** The rendered round-0 prompts: system prompt, user prefix, and initial request. */
export interface InitialPrompts {
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
 * const builder = new PromptBuilder(prompt, vars, logger);
 * const initial = await builder.buildInitialPrompts();
 * const firstRoundRequest = await builder.buildUserRequest(1);
 * ```
 */
export class PromptBuilder {
  constructor(
    private readonly agentPrompt: AgentPrompt,
    private readonly userVars: Record<string, unknown>,
    private readonly logger?: AgentTrace,
  ) {}

  /**
   * Render the initial system, prefix, and request prompts for round 0.
   */
  public async buildInitialPrompts(): Promise<InitialPrompts> {
    const [systemPrompt, userRequest, userPrefix] = await Promise.all([
      getSystemPromptWithRules(this.agentPrompt.systemPrompt, this.userVars),
      this.buildUserRequest(0),
      renderPrompt(this.agentPrompt.userPrefix, this.userVars),
    ]);

    return { systemPrompt, userPrefix, userRequest };
  }

  /**
   * Render the user request for the supplied round.
   *
   * @param currRound Zero-based round number (round 0 selects the initial template)
   * @remarks Rounds beyond the configured templates fall back to the second template (index 1).
   */
  public async buildUserRequest(currRound: number): Promise<string> {
    const template = this.getRoundTemplate(currRound);

    if (!template) {
      this.logger?.warn(
        currRound === 0
          ? 'No initial user request configured. Returning empty prompt.'
          : `No prompt configured for round ${currRound}. Returning empty prompt.`,
      );
      return '';
    }

    return renderPrompt(template, this.userVars);
  }

  private getRoundTemplate(currRound: number): string | undefined {
    const { userRequest } = this.agentPrompt;
    const templates = userRequest ? ensureArray(userRequest) : [];

    const round = Math.max(0, currRound);
    if (round < templates.length) return templates[round];

    // For rounds beyond configured templates, fall back to the last template.
    // Multi-template agents reuse templates[1] (reflection prompt) for all
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

export async function buildInitialToolUsePrompts(
  agentPrompt: AgentPrompt,
  userVars: Record<string, unknown>,
  logger?: AgentTrace,
  options?: {
    resolvedToolNames?: readonly string[];
    hasDelegationTools?: boolean;
    isSubagent?: boolean;
  },
): Promise<InitialPrompts & { instructionSuffix: string }> {
  const builder = new PromptBuilder(agentPrompt, userVars, logger);
  const initial = await builder.buildInitialPrompts();

  const memoryEnabled = options?.resolvedToolNames?.includes('memory') ?? false;

  // Build instruction suffix: always include tool-use instructions,
  // optionally append memory instructions and workspace info
  const suffixParts = [TOOL_USE_INSTRUCTIONS];
  if (memoryEnabled) {
    suffixParts.push(MEMORY_TOOL_INSTRUCTIONS);
    if (options?.hasDelegationTools) {
      suffixParts.push(ORCHESTRATOR_MEMORY_INSTRUCTIONS);
    } else if (options?.isSubagent) {
      suffixParts.push(SUBAGENT_MEMORY_INSTRUCTIONS);
    }
  }
  suffixParts.push(await buildWorkspaceInfoBlock());

  return {
    ...initial,
    instructionSuffix: await renderPrompt(suffixParts.join('\n'), userVars),
  };
}
