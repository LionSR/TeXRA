// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import type {
  AgentPrompt,
  AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { loadTexraRules } from '@utils/files/rulesUtils';
import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';

// Local imports - utilities
import { renderPrompt } from './promptUtils';

type PromptBuilderSetting = Pick<AgentWorkflowSetting, 'prefills'>;

/** Instructions appended to tool-use agent prompts */
const TOOL_USE_INSTRUCTIONS = `<tool_use_instructions>
IMPORTANT — Working directory: The bash tool already executes every command from {{ CWD }}. You are already in the workspace, so run commands directly with relative paths (e.g., \`ls src/\`, \`find . -name "*.tex"\`, \`cat README.md\`). Scope file searches to \`.\` or a subdirectory, or use the glob/grep tools.

When using a tool, follow the JSON schema exactly and include all required properties.
Always produce valid JSON when calling a tool.
Prefer using tools over asking the user to take manual actions.
If you say you will perform an action, immediately call the corresponding tool.
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
IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.

MEMORY PROTOCOL:
1. Use the \`view\` command of your \`memory\` tool to check for earlier progress.
2. ... (work on the task) ...
   - As you make progress, record status, progress, and thoughts in your memory.
   - Record user preferences: writing style, coding conventions, formatting requirements, workflow preferences, and any explicit or implicit guidelines the user follows.
   - When git is available, look into git history (commit messages, PR descriptions, recent changes) to understand project context, coding patterns, and conventions.

Your memory persists across conversations, allowing you to continue tasks and remember user preferences over time.

Note: when editing your memory folder, always try to keep its content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. Do not create new files unless necessary.

PINNED MEMORIES:
Some memories may be marked as "pinned" (shown with [pinned] in directory listings and file headers). These are core long-term insights—techniques, strategies, pitfalls, and best practices accumulated over time. They represent the kind of knowledge a seasoned researcher would build up through years of project experience.

- Always consult pinned memories at session start; they contain the most valuable accumulated knowledge.
- When you discover a reusable trick, technique, strategy, pitfall, or best practice, consider using the \`pin\` command to mark it as a core memory.
- Do NOT pin task-specific progress notes or ephemeral status updates. Only pin long-term reusable insights.
- Use \`unpin\` to remove the pinned status when a memory is no longer relevant as a core insight.
</memory_tool_instructions>`;

/** Memory instructions for orchestrators that launch subagents. */
const ORCHESTRATOR_MEMORY_INSTRUCTIONS = `<orchestrator_memory_protocol>
The /memories directory is shared with all subagents you launch. Subagents can read and write the same files. Use this for persistent context that should survive across conversations—not as a substitute for subagent result delivery (subagents report back automatically via follow-up messages). Good uses: project conventions, user preferences, research bibliographies that build up over time.

Beyond basic progress tracking, record reusable intelligence: what approaches worked or failed and why, project structure and conventions you discovered, user preferences revealed through corrections or rejections, and effective problem-solving strategies. Consult these at session start instead of rediscovering from scratch.
</orchestrator_memory_protocol>`;

/** Memory instructions for subagents launched by an orchestrator. */
const SUBAGENT_MEMORY_INSTRUCTIONS = `<subagent_memory_protocol>
The /memories directory is shared with the orchestrator and other subagents. Check /memories first—it may contain context from prior sessions or other agents. Write to memory for information that should persist beyond this session (e.g., discovered conventions, useful references). Your primary results should go in your response, not in memory.
</subagent_memory_protocol>`;

/**
 * Notice injected into a delegated subagent's system suffix when its YAML
 * requested delegation tools but the max-delegation-depth gate removed
 * them. Without this, the LLM keeps trying to call delegate_agent /
 * delegate_workflow and fails confusingly.
 */
const NESTED_DELEGATION_BLOCKED_INSTRUCTIONS = `<delegation_depth_reached>
You are a delegated subagent. The configured delegation depth does not allow you to delegate further, so the delegation tools (delegate_agent, delegate_workflow, resume_agent, propose_agent, propose_workflow) are unavailable to you. Do not attempt to call them. Complete the task directly using the tools you have, or report back to the orchestrator if the task truly requires further delegation.
</delegation_depth_reached>`;

/**
 * Combine the base system prompt with optional rules from `.texrarules`.
 *
 * @param systemPrompt Base system prompt template
 * @param userVars Variables for template rendering
 * @returns Full system prompt string
 */
export async function getSystemPromptWithRules(
  systemPrompt: string,
  userVars: Record<string, any>,
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
 * const builder = new PromptBuilder(prompt, setting, vars, logger);
 * const initial = await builder.buildInitialPrompts();
 * const firstRoundRequest = await builder.buildUserRequest(1);
 * const prefill = await builder.buildPrefill(0);
 * ```
 */
export class PromptBuilder {
  constructor(
    private readonly agentPrompt: AgentPrompt,
    private readonly agentSetting: PromptBuilderSetting,
    private readonly userVars: Record<string, any>,
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

  /**
   * Return the prefill value that should seed the assistant response.
   *
   * @param currRound Zero-based conversation round index
   * @remarks Reuses the first configured prefill when subsequent rounds omit a value.
   */
  public async buildPrefill(currRound: number): Promise<string> {
    const prefills = this.agentSetting.prefills;
    if (!prefills || prefills.length === 0) {
      return '';
    }

    const normalizedRound = Math.max(0, currRound);
    if (normalizedRound < prefills.length) {
      return prefills[normalizedRound] ?? '';
    }

    this.logger?.debug(
      `No prefill configured for round ${currRound}. Reusing first prefill.`,
    );

    return prefills[0] ?? '';
  }

  private getRoundTemplate(currRound: number): string | undefined {
    const { userRequest } = this.agentPrompt;
    let templates: string[];
    if (Array.isArray(userRequest)) {
      templates = userRequest;
    } else if (userRequest) {
      templates = [userRequest];
    } else {
      templates = [];
    }

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
  userVars: Record<string, any>,
  logger?: AgentTrace,
  options?: {
    resolvedToolNames?: readonly string[];
    hasDelegationTools?: boolean;
    isSubagent?: boolean;
    /**
     * True when the agent's YAML requested delegation tools but they were
     * filtered out by the nested-delegation gate. Triggers a notice telling
     * the LLM it cannot delegate further.
     */
    nestedDelegationBlocked?: boolean;
  },
): Promise<InitialPrompts & { instructionSuffix: string }> {
  const builder = new PromptBuilder(
    agentPrompt,
    { prefills: [] },
    userVars,
    logger,
  );
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
  if (options?.nestedDelegationBlocked) {
    suffixParts.push(NESTED_DELEGATION_BLOCKED_INSTRUCTIONS);
  }
  suffixParts.push(await buildWorkspaceInfoBlock());

  return {
    ...initial,
    instructionSuffix: await renderPrompt(suffixParts.join('\n'), userVars),
  };
}
