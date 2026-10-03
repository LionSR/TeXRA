/**
 * What the delegation tools can launch, and the text that tells the model.
 *
 * The agents a delegation tool can launch, the models a child can run and
 * whether worktrees are on all change while a run lives (agent visibility, a
 * team swap, a new credential, the worktree setting). The step reads them
 * (`readDelegationTargets`) into the run's context; the system text renders
 * them once, at the step that freezes it (`delegationSection`), and a later
 * change reaches the model as lines of the context update
 * (`delegationUpdate`). The tool descriptions never change with them, so
 * neither does the cached prefix. A launch is checked against the live lists
 * when it is called (`requireVisibleAgent`, `selectAvailableDelegationModel`),
 * and a refusal names the current ones.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { modelRefOf } from '@texra-ai/llm';
import { resolveDelegationScopeAgents } from '@agent/index/agentRegistry';
import { withLogChannel } from '@logger/effectLog';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { decideRunModel } from '@model/runModelDecision';
import { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type {
  AgentCategory,
  AgentDelegationScope,
  DelegationTargets,
  ModelOptionData,
  ToolDefinition,
} from '@shared/schemas';
import { isModelOptionAvailable } from '@shared/schemas';
import { AGENT_TOOL_NAME } from '@shared/constants/delegationTools';
import { unique } from '@utils/core';
import { isWorktreeSupportEnabled } from '@utils/config/worktreeConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

const availableModelNames = (models: readonly ModelOptionData[]): string[] =>
  models.filter(isModelOptionAvailable).map((model) => model.value);

/* -------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------- */

/**
 * The targets the offered `definitions` can launch, or `undefined` when they
 * hold no delegation tool. A delegation tool declares the agent category it
 * launches (`availabilityCategory`); the agents are the run's pinned
 * delegation scope's, or the workspace's visible ones.
 */
export const readDelegationTargets = Effect.fn('readDelegationTargets')(
  function* (
    definitions: readonly ToolDefinition[],
    stores: ModelOptionStores,
    scope: AgentDelegationScope | undefined,
  ) {
    const launchers = new Map<AgentCategory, string[]>();
    for (const { name, availabilityCategory } of definitions)
      if (name === AGENT_TOOL_NAME && availabilityCategory !== undefined)
        for (const category of [availabilityCategory].flat())
          launchers.set(category, [...(launchers.get(category) ?? []), name]);
    if (launchers.size === 0) return undefined;
    const agents: DelegationTargets['agents'] = [];
    for (const [category, tools] of launchers) {
      const entries = yield* resolveDelegationScopeAgents(
        stores,
        scope,
        category,
      );
      agents.push({
        category,
        tools,
        agents: entries.map(({ name, description, tools: agentTools }) => ({
          name,
          // One line per agent: a blank line in a (user-defined) description
          // would otherwise read as the end of the list.
          description: (description || 'No description').replaceAll(
            /\s*\n\s*/g,
            ' ',
          ),
          tools: agentTools ?? [],
        })),
      });
    }
    const models = yield* readModelAvailabilityInputs(stores).pipe(
      Effect.map((inputs) => availableModelNames(modelOptionsFrom(inputs))),
      // A failed read (an unreadable store, a host call that rejected) tells
      // the model the list is unknown rather than failing the step, and is
      // logged. `Effect.catch` recovers typed failures only: the finisher's
      // invariant is a programming error and fails the run as a defect.
      Effect.catch((error) =>
        Effect.logWarning(
          `Could not load the models available for delegation: ${toErrorMessage(error)}`,
        ).pipe(withLogChannel('DelegationTargets'), Effect.as(null)),
      ),
    );
    return {
      agents,
      models,
      worktree: launchers.has('toolUse')
        ? yield* isWorktreeSupportEnabled(stores)
        : null,
    } satisfies DelegationTargets;
  },
);

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */

const worktreeLine = (enabled: boolean): string =>
  enabled
    ? 'Git worktree support: ENABLED. Pass `working_directory` (absolute path) to `agent` to run a tool-use subagent rooted in a git worktree; every tool call in the subagent resolves paths against that directory. The subagent reports its working directory back in its delivery result.'
    : 'Git worktree support: DISABLED in this workspace. Do not pass `working_directory` to `agent` because the call will be rejected. Ask the user to turn on `texra.git.worktreeSupport` ("Subagent worktrees" in Settings > General > Git) if worktree operation is needed.';

/** The system text's delegation section, rendered once, at the freeze. */
export function delegationSection(targets: DelegationTargets): string {
  const lines = targets.agents.flatMap(({ tools, agents }) => {
    const head = `Available agents for ${tools.join(', ')}:`;
    if (agents.length === 0)
      return [
        `${head} none are currently enabled in this workspace. Ask the user to enable delegation targets in Settings → Agents before delegating.`,
      ];
    return [
      head,
      ...agents.map(
        ({ name, description, tools: agentTools }) =>
          `- ${name}: ${description}${agentTools.length > 0 ? `\n  Tools: ${agentTools.join(', ')}` : ''}`,
      ),
    ];
  });
  if (targets.models === null)
    lines.push(
      'Available models: unavailable to load; omit model unless the user explicitly requested one.',
    );
  else if (targets.models.length === 0)
    lines.push(
      'Available models: none currently available. Ask the user to configure model access before delegating.',
    );
  else lines.push(`Available models: ${targets.models.join(', ')}`);
  if (targets.worktree !== null) lines.push(worktreeLine(targets.worktree));
  return `<delegation_targets>\n${lines.join('\n')}\n</delegation_targets>`;
}

/** `now` against `told`, as "now available: …; no longer available: …", or
 *  null when they hold the same names. */
function namesChange(
  told: readonly string[],
  now: readonly string[],
): string | null {
  const added = now.filter((name) => !told.includes(name));
  const removed = told.filter((name) => !now.includes(name));
  const parts = [
    ...(added.length > 0 ? [`now available: ${added.join(', ')}`] : []),
    ...(removed.length > 0
      ? [`no longer available: ${removed.join(', ')}`]
      : []),
  ];
  return parts.length === 0 ? null : parts.join('; ');
}

/**
 * The lines that tell the model how the delegation targets changed since it
 * was told `told` (undefined: none). A delegation tool that left is reported
 * with the tools, not here.
 */
export function delegationUpdate(
  told: DelegationTargets | undefined,
  now: DelegationTargets,
): string[] {
  const lines = now.agents.flatMap(({ category, tools, agents }) => {
    const before = told?.agents.find((group) => group.category === category);
    const change = namesChange(
      before?.agents.map(({ name }) => name) ?? [],
      agents.map(({ name }) => name),
    );
    return change === null ? [] : [`Agents for ${tools.join(', ')} ${change}.`];
  });
  if (now.models === null) {
    if (told?.models !== null)
      lines.push(
        'The models available for delegation could not be loaded; omit model unless the user explicitly requested one.',
      );
  } else {
    const change = namesChange(told?.models ?? [], now.models);
    if (change !== null) lines.push(`Models for delegation ${change}.`);
  }
  if (now.worktree !== null && now.worktree !== (told?.worktree ?? null))
    lines.push(worktreeLine(now.worktree));
  return lines;
}

/* -------------------------------------------------------------------------
 * Launch-time model choice
 * ---------------------------------------------------------------------- */

const NO_DELEGATION_MODELS_MESSAGE =
  'No models are currently available for delegation. Review or configure model access before delegating.';

/**
 * Decide which model a delegated run uses: an explicit override, else the
 * parent run's model, else the first model the user has access to — checked
 * against the live availability list so an unavailable choice fails here rather
 * than after launch.
 */
export const selectAvailableDelegationModel = Effect.fn(
  'selectAvailableDelegationModel',
)(function* (input: {
  readonly requestedModel?: string | null;
  readonly parentModel?: string | null;
  /**
   * The setting slots the availability read answers from: the calling run's
   * session roots. Callers that reach this from outside their run — an
   * approved proposal, a script's per-call model routing — hand in
   * the roots of the session the delegation belongs to, so the answer does not
   * depend on which frame the fiber resumed in.
   */
  readonly settings: SettingsStores;
}) {
  const inputs = yield* readModelAvailabilityInputs({
    ...input.settings,
    secrets: yield* Secrets,
  });
  const models = modelOptionsFrom(inputs);
  const availableModels = unique(
    availableModelNames(models)
      .map((model) => model.trim())
      .filter(Boolean),
  );
  if (availableModels.length === 0) {
    return yield* Effect.fail(new Error(NO_DELEGATION_MODELS_MESSAGE));
  }

  const decision = decideRunModel(
    [
      { model: input.requestedModel, reason: 'explicit-override' },
      {
        model: input.parentModel,
        reason: 'parent-run',
        fallbackMode: 'silent',
      },
      { model: availableModels[0], reason: 'access-list-default' },
    ],
    // Availability belongs to the model; an `@effort` suffix does not change it.
    (model) => availableModels.includes(modelRefOf(model) ?? model),
  );
  if (!decision) {
    return yield* Effect.fail(new Error(NO_DELEGATION_MODELS_MESSAGE));
  }
  if (decision.unavailable) {
    const requestedModel = input.requestedModel?.trim() || null;
    return yield* Effect.fail(
      new Error(
        `Model "${requestedModel}" is not currently available for delegation with the currently configured model access. Available models: ${availableModels.join(', ')}.`,
      ),
    );
  }
  return decision.model;
});
