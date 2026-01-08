// Local imports - agent
import type { AgentPrompt } from '@agent/core/AgentDataclass';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import type { AgentLogger } from '@logger/AgentLogger';
import { loadTexraRules } from '@utils/files/rulesUtils';

// Local imports - utilities
import { renderPrompt } from './promptUtils';

type PromptBuilderSetting = Pick<AgentWorkflowSetting, 'prefills'>;

/** Instructions appended to tool-use agent prompts */
const TOOL_USE_INSTRUCTIONS = `<tool_use_instructions>
When using a tool, follow the JSON schema exactly and include all required properties.
Always produce valid JSON when calling a tool.
Prefer using tools over asking the user to take manual actions.
If you say you will perform an action, immediately call the corresponding tool.
Never mention tool names when speaking to the user.
Do not call tools that are not provided or any multi_tool_use variants.
Call tools sequentially and wait for the output before calling another.
For math in responses, use $...$ for inline and $$...$$ for display math (not \\(...\\) or \\[...\\]).
</tool_use_instructions>`;

/** Instructions appended when memory tool is enabled */
const MEMORY_TOOL_INSTRUCTIONS = `<memory_tool_instructions>
You have access to a persistent memory system under /memories for storing important information across sessions.
Use the memory tool to:
- Store key findings, decisions, or context that may be useful later
- Organize notes by topic using subdirectories (e.g., /memories/project-notes/, /memories/references/)
- Review existing memories before starting complex tasks to maintain continuity

Memory commands: view (read file/directory), create (new file), str_replace (edit), insert (add lines), delete, rename.
Keep memory files concise and well-organized. Prefer updating existing files over creating duplicates.
</memory_tool_instructions>`;

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
  const rules = await loadTexraRules();
  return rules ? `${basePrompt}\n${rules}` : basePrompt;
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
    private readonly logger?: AgentLogger,
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
      const message =
        currRound === 0
          ? 'No initial user request configured. Returning empty prompt.'
          : `No prompt configured for round ${currRound}. Returning empty prompt.`;
      this.logger?.warn(message);
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
    const normalizedRound = Math.max(0, currRound);
    const requestArray = Array.isArray(this.agentPrompt.userRequest)
      ? this.agentPrompt.userRequest
      : this.agentPrompt.userRequest
        ? [this.agentPrompt.userRequest]
        : [];

    const template = requestArray[normalizedRound];
    if (template !== undefined) {
      return template;
    }

    // For rounds beyond configured templates, fall back to the second template
    if (normalizedRound > 0 && requestArray.length > 1) {
      this.logger?.debug(
        `No prompt configured for round ${currRound}. Falling back to second template (index 1).`,
      );
      return requestArray[1];
    }

    return undefined;
  }
}

export type InitialPrompts = Awaited<
  ReturnType<PromptBuilder['buildInitialPrompts']>
>;

export interface ToolUsePromptOptions {
  /** Whether the memory tool is enabled for this session */
  memoryEnabled?: boolean;
}

export async function buildInitialToolUsePrompts(
  agentPrompt: AgentPrompt,
  userVars: Record<string, any>,
  logger?: AgentLogger,
  options?: ToolUsePromptOptions,
): Promise<InitialPrompts & { instructionSuffix: string }> {
  const builder = new PromptBuilder(
    agentPrompt,
    { prefills: [] },
    userVars,
    logger,
  );
  const initial = await builder.buildInitialPrompts();

  // Build instruction suffix: always include tool-use instructions,
  // optionally append memory instructions when enabled
  const suffixParts = [TOOL_USE_INSTRUCTIONS];
  if (options?.memoryEnabled) {
    suffixParts.push(MEMORY_TOOL_INSTRUCTIONS);
  }

  return {
    ...initial,
    instructionSuffix: suffixParts.join('\n'),
  };
}
