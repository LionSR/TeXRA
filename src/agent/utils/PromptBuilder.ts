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
import {
  NormalizedAgentPrompts,
  normalizeAgentPrompts,
} from './promptNormalization';

/**
 * Centralises prompt construction logic for reflection-capable agents.
 *
 * @remarks
 * The builder renders all prompts lazily so callers can defer work until the
 * relevant conversation stage. Reflection rounds pass a 1-indexed counter so
 * round 1 maps to the first reflection template, while process rounds use a
 * zero-based index.
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
  private normalizedPrompts?: NormalizedAgentPrompts;

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
    const { initialRequest } = this.getNormalizedPrompts();

    const [systemPrompt, userRequest, userPrefix] = await Promise.all([
      getSystemPromptWithRules(this.agentPrompt.systemPrompt, this.userVars),
      renderPrompt(initialRequest, this.userVars),
      renderPrompt(this.agentPrompt.userPrefix, this.userVars),
    ]);

    return { systemPrompt, userPrefix, userRequest };
  }

  /**
   * Render the reflection prompt for the supplied round.
   *
   * @param currRound 1-indexed reflection round number (round 1 selects the first template)
   * @remarks Falls back to the first reflection template when a later round is undefined.
   */
  public async buildReflectPrompt(currRound: number): Promise<string> {
    const groupId = this.logger?.getActiveGroupId();
    const normalizedRound = Math.max(1, currRound);

    let reflectTemplate: string | undefined;

    const reflectionTemplates = this.getReflectionTemplates();
    if (reflectionTemplates.length > 0) {
      const index = normalizedRound - 1;
      reflectTemplate = reflectionTemplates[index];

      if (reflectTemplate === undefined) {
        const fallback = reflectionTemplates[0];

        if (fallback) {
          this.logger?.debug(
            `No reflection prompt configured for round ${currRound}. Falling back to first template.`,
            groupId,
          );
        }

        reflectTemplate = fallback;
      }
    }

    if (!reflectTemplate) {
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
   * @param currRound Zero-based conversation round index (0 for process rounds, 1+ for reflections)
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

    const groupId = this.logger?.getActiveGroupId();
    this.logger?.debug(
      `No prefill configured for round ${currRound}. Reusing first prefill.`,
      groupId,
    );

    return prefills[0] ?? '';
  }

  private getReflectionTemplates(): string[] {
    const { reflectionPrompts } = this.getNormalizedPrompts();
    return reflectionPrompts;
  }

  private getNormalizedPrompts(): NormalizedAgentPrompts {
    if (!this.normalizedPrompts) {
      this.normalizedPrompts = normalizeAgentPrompts(this.agentPrompt);
    }

    return this.normalizedPrompts;
  }
}

export type InitialPrompts = Awaited<
  ReturnType<PromptBuilder['buildInitialPrompts']>
>;
