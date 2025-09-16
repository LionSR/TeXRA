// Local imports - agent
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';

// Local imports - utilities
import {
  getPrefillForRound,
  getReflectPromptForRound,
  getSystemPromptWithRules,
} from './promptHelpers';
import { renderPrompt } from './promptUtils';

/**
 * Bundles prompt construction logic so agents can share consistent behaviour.
 */
export class PromptBuilder {
  constructor(
    private readonly agentPrompt: AgentPrompt,
    private readonly agentSetting: AgentSetting,
    private readonly userVars: Record<string, any>,
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
      return '';
    }

    return renderPrompt(reflectTemplate, this.userVars);
  }

  /**
   * Return the prefill value that should seed the assistant response.
   *
   * @param currRound The current round number (0-based for process, 1+ for reflection)
   */
  public getPrefill(currRound: number): string {
    return getPrefillForRound(this.agentSetting.prefills, currRound);
  }
}

export type InitialPrompts = Awaited<
  ReturnType<PromptBuilder['buildInitialPrompts']>
>;
