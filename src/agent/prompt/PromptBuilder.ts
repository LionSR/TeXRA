// Local imports - agent
import type { AgentTrace } from '@agent/trace/AgentTrace';
import type { AgentPrompt } from '@agent/core/definition/AgentDataclass';

// Local imports - utilities
import { ensureArray } from '@utils/core';
import { renderPrompt } from '@utils/prompt';
import { loadTexraRules } from '@utils/files/rulesUtils';
import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';

/** Instructions appended to tool-use agent prompts */
const TOOL_USE_INSTRUCTIONS = `<tool_use_instructions>
IMPORTANT — Working directory: The bash tool already executes every command from {{ CWD }}. You are already in the workspace, so run commands directly with relative paths (e.g., \`ls src/\`, \`find . -name "*.tex"\`, \`cat README.md\`). Scope file searches to \`.\` or a subdirectory, or use the glob/grep tools.
Explicit user constraints override general workflow guidance elsewhere in the agent prompt. If the user forbids memory, planning, todos, file access, or a tool, do not use it; report any resulting conflict instead.

When using a tool, follow the JSON schema exactly and include all required properties.
Always produce valid JSON when calling a tool.
Prefer using tools over asking the user to take manual actions.
If you say you will perform an action, immediately call the corresponding tool.
When an approved plan or autonomous objective is active, work toward it end to end: keep going and verify against real evidence rather than pausing to confirm each step or to summarize progress, and stop only when it is verifiably done or you are genuinely blocked on something only the user can provide.
Never mention tool names when speaking to the user.
Do not call tools that are not provided or any multi_tool_use variants.
Call tools sequentially and wait for the output before calling another.
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
Pinned memories are always loaded (unless the user forbids memory use): at session start, \`view\` the \`/memories\` directory to find entries marked [pinned] — if the listing is truncated, continue it until you have seen every [pinned] entry — then \`view\` each pinned file so its content actually applies, regardless of how self-contained the request looks. Beyond that, use memory when the request may depend on prior sessions, durable user preferences, or shared agent context; for a self-contained request, do not read unpinned memory files or write memory merely because the tool is available (the directory listing itself is fine — needed to find pinned entries).

MEMORY PROTOCOL:
1. At session start (unless the user forbids memory use), \`view\` \`/memories\`, then \`view\` each [pinned] file found; when memory is relevant beyond that, review the rest of the directory for earlier progress.
2. ... (work on the task) ...
   - For long-running work that needs continuity, record durable progress and decisions in memory.
   - Record user preferences: writing style, coding conventions, formatting requirements, workflow preferences, and any explicit or implicit guidelines the user follows.
   - When project context, coding patterns, or conventions are relevant to the task and git is available, look into git history (commit messages, PR descriptions, recent changes) to understand them.

Your memory persists across conversations, allowing you to continue tasks and remember user preferences over time.

Note: when editing your memory folder, always try to keep its content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. Do not create new files unless necessary.

PINNED MEMORIES:
Some memories may be marked as "pinned" (shown with [pinned] in directory listings and file headers). These are core long-term insights—techniques, strategies, pitfalls, and best practices accumulated over time. They represent the kind of knowledge a seasoned researcher would build up through years of project experience.

- Always read each pinned memory file at session start (unless the user forbids memory use), even for requests that otherwise look self-contained; they contain the most valuable accumulated knowledge, and the directory listing alone does not load their content.
- When you discover a reusable trick, technique, strategy, pitfall, or best practice, consider using the \`pin\` command to mark it as a core memory.
- Do NOT pin task-specific progress notes or ephemeral status updates. Only pin long-term reusable insights.
- Use \`unpin\` to remove the pinned status when a memory is no longer relevant as a core insight.
</memory_tool_instructions>`;

/** Memory instructions for orchestrators that launch subagents. */
const ORCHESTRATOR_MEMORY_INSTRUCTIONS = `<orchestrator_memory_protocol>
The /memories directory is shared with all subagents you launch. Subagents can read and write the same files. Use this for persistent context that should survive across conversations—not as a substitute for subagent result delivery (subagents report back automatically via follow-up messages). Good uses: project conventions, user preferences, research bibliographies that build up over time.

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
  public async buildInitialPrompts(): Promise<{
    systemPrompt: string;
    userPrefix: string;
    userRequest: string;
  }> {
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

export type InitialPrompts = Awaited<
  ReturnType<PromptBuilder['buildInitialPrompts']>
>;

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
