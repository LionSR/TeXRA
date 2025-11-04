// Local imports - agent
import type {
  AgentPrompt,
  AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';

// Local imports - log
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import { getSystemPromptWithRules } from './promptHelpers';
import { renderPrompt } from './promptUtils';

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
    private readonly agentSetting: AgentWorkflowSetting,
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
    const groupId = this.logger?.withCurrentGroup((id) => id);
    const template = this.getRoundTemplate(currRound);

    if (!template) {
      const message =
        currRound === 0
          ? 'No initial user request configured. Returning empty prompt.'
          : `No prompt configured for round ${currRound}. Returning empty prompt.`;
      this.logger?.warn(message, groupId);
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

    const groupId = this.logger?.withCurrentGroup((id) => id);
    this.logger?.debug(
      `No prefill configured for round ${currRound}. Reusing first prefill.`,
      groupId,
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
      const groupId = this.logger?.withCurrentGroup((id) => id);
      this.logger?.debug(
        `No prompt configured for round ${currRound}. Falling back to second template (index 1).`,
        groupId,
      );
      return requestArray[1];
    }

    return undefined;
  }
}

export type InitialPrompts = Awaited<
  ReturnType<PromptBuilder['buildInitialPrompts']>
>;
