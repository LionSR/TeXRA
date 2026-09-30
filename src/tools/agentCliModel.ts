/**
 * The model and effort an agent CLI (Claude Code, Codex) runs with.
 *
 * Both CLIs name their model the way every TeXRA setting does, as an llm-zoo
 * selection string (`provider/id[@effort]`), and both send the effort the one
 * reasoning policy chooses: the call's own level, else the model string's,
 * else the user's saved level, else the policy default, snapped to a level
 * the model (and the route, when it reports one) accepts.
 */
import { Effect } from 'effect';

import {
  chooseReasoning,
  ReasoningChoiceError,
  type ChooseReasoningOptions,
  type ReasoningChoice,
} from '@model/reasoningChoice';
import { selectModel, type SelectedModel } from '@shared/model/modelSelection';
import {
  AgentCliEffortSchema,
  ToolError,
  type AgentCliEffort,
} from '@shared/schemas';
import type { ModelConfig } from 'llm-zoo';

/** Which models an agent CLI accepts, for validation and its error message. */
export interface AgentCliModelRule {
  /** The CLI as the user knows it, e.g. `Claude Code`. */
  readonly cli: string;
  readonly eligible: (config: ModelConfig) => boolean;
  /** What an eligible model is, e.g. `a non-retired Anthropic model`. */
  readonly requirement: string;
}

export interface AgentCliModel {
  readonly selection: SelectedModel;
  readonly choice: ReasoningChoice;
  /** The level to send; `undefined` sends none (the model has no effort control). */
  readonly effort: AgentCliEffort | undefined;
}

/** The registry model a model string names, if the CLI can run it. */
export function selectAgentCliModel(
  id: string,
  rule: AgentCliModelRule,
): SelectedModel {
  const selection = selectModel(id);
  if (selection === undefined) {
    throw new ToolError(
      `Unknown model "${id}" for ${rule.cli}: expected a model reference such as provider/id, optionally with @effort.`,
    );
  }
  if (!rule.eligible(selection.config)) {
    throw new ToolError(
      `${rule.cli} cannot run "${id}" (${selection.config.label}): it needs ${rule.requirement}.`,
    );
  }
  return selection;
}

/**
 * The effort to send for a selection: `effort` (the call's own level)
 * overrides the model string's, and `options.userEffort` is the saved level.
 */
export function agentCliReasoning(
  selection: SelectedModel,
  effort: AgentCliEffort | undefined,
  options: ChooseReasoningOptions,
): AgentCliModel {
  const request =
    effort === undefined ? selection.request : { ...selection.request, effort };
  const choice = chooseReasoning(selection.config, request, options);
  const sent = AgentCliEffortSchema.safeParse(choice.effort);
  return {
    selection,
    choice,
    effort: sent.success ? sent.data : undefined,
  };
}

/** Run a model/effort resolution, reporting a refusal as the tool's error. */
export const resolveAgentCliModel = <A>(
  resolve: () => A,
): Effect.Effect<A, ToolError> =>
  Effect.try({
    try: resolve,
    catch: (error) =>
      error instanceof ToolError
        ? error
        : new ToolError(
            error instanceof ReasoningChoiceError
              ? error.message
              : `Model selection failed: ${String(error)}`,
            { cause: error },
          ),
  });
