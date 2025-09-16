// Local imports - agent
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';

// Local imports - log
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import {
  getPrefillForRound,
  getReflectPromptForRound,
  getSystemPromptWithRules,
} from './promptHelpers';
import { renderPrompt } from './promptUtils';

/**
 * Centralises prompt construction logic for reflection-capable agents.
 *
 * @remarks
 * The builder renders all prompts lazily so callers can defer work until the
 * relevant conversation stage. Reflection rounds are 1-indexed while process
 * rounds begin at 0.
 *
 * @example
 * ```ts
 * const builder = new PromptBuilder(prompt, setting, vars, logger);
 * const initial = await builder.buildInitialPrompts();
 * const firstReflect = await builder.buildReflectPrompt(1);
 * const prefill = await builder.buildPrefill(0);
 * ```
 */
export class PromptBuilder {
  constructor(
    private readonly agentPrompt: AgentPrompt,
    private readonly agentSetting: AgentSetting,
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
      renderPrompt(this.agentPrompt.userRequest, this.userVars),
      renderPrompt(this.agentPrompt.userPrefix, this.userVars),
    ]);

    return { systemPrompt, userPrefix, userRequest };
  }

  /**
   * Render the reflection prompt for the supplied round.
   *
   * @param currRound The reflection round (1-indexed for reflection rounds)
   */
  public async buildReflectPrompt(currRound: number): Promise<string> {
    const reflectTemplate = getReflectPromptForRound(
      this.agentPrompt,
      currRound,
    );

    if (!reflectTemplate) {
      const groupId = this.logger?.getActiveGroupId();
      this.logger?.warn(
        `No reflection prompt configured for round ${currRound}. Returning empty prompt.`,
        groupId,
      );
      return '';
    }

    return renderPrompt(reflectTemplate, this.userVars);
  }

  /**
   * Return the prefill value that should seed the assistant response.
   *
   * @param currRound The current round number (0-based for process, 1+ for reflection)
   */
  public async buildPrefill(currRound: number): Promise<string> {
    return getPrefillForRound(this.agentSetting.prefills, currRound);
  }
}

export type InitialPrompts = Awaited<
  ReturnType<PromptBuilder['buildInitialPrompts']>
>;
