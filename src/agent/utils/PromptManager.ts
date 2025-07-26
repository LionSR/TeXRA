// Local imports
import { renderPrompt } from './promptUtils';
import { getSystemPromptWithRules } from './promptHelpers';
import { AgentPrompt } from '../core/AgentDataclass';
import { ToolState } from '../core/ToolState';

/** Utility class for rendering prompts for agents. */
export class PromptManager {
  /**
   * Render system prompt, user request and user prefix for the initial round.
   */
  static async renderInitialPrompts(
    agentPrompt: AgentPrompt,
    userVars: Record<string, any>,
    toolState: ToolState,
  ): Promise<{
    systemPrompt: string;
    userRequest: string;
    userPrefix: string;
  }> {
    const [systemPrompt, userRequest, userPrefix] = await Promise.all([
      getSystemPromptWithRules(agentPrompt.systemPrompt, userVars),
      renderPrompt(agentPrompt.userRequest, userVars),
      renderPrompt(agentPrompt.userPrefix, userVars),
    ]);
    return {
      systemPrompt,
      userRequest,
      userPrefix,
    };
  }

  /**
   * Render the reflection prompt for a follow-up round.
   */
  static async renderReflectionPrompt(
    agentPrompt: AgentPrompt,
    userVars: Record<string, any>,
    toolState: ToolState,
  ): Promise<string> {
    const userRequestReflect = await renderPrompt(
      agentPrompt.userReflect,
      userVars,
    );
    let userMessage = userRequestReflect ? `${userRequestReflect}\n` : '';
    if (toolState.texcountStats) {
      userMessage = `${toolState.texcountStats}${userMessage}`;
    }
    return userMessage;
  }
}
