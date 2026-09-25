/**
 * Live availability annotations for delegation tool descriptions, and the
 * roster/model resolution behind them.
 *
 * The delegate_agent / delegate_workflow descriptions ship with placeholder
 * "Available agents:", "Available models:", and "Git worktree support:" lines.
 * All three depend on state the user can change after the tool registry is
 * built (roster visibility, a multi-agent preset swap, model credentials, the
 * worktree setting), so each line is resolved per run at the `resolveAgentTools`
 * boundary instead of being frozen into the tool definition at first access.
 *
 * Keeping the roster current is what lets the agent-native delegation
 * convention work: delegating agents (orchestrator, engineer, …) are told to
 * pick from the tool description's "Available agents" list, so a stale list
 * made them attempt agents that are no longer in the roster and discover the
 * mismatch only via a failed delegate call.
 *
 * Each annotation owns its anchor pattern and copy; they share one injection
 * contract (`replaceDelegationDescriptionBlock`): only touch delegation tools
 * that have a description, replace the matched block in place (via a replacer
 * function so a `$` in the replacement is never read as a pattern token), and —
 * for annotations that must default onto a description with no anchor — append
 * the block instead.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { resolveDelegationScopeAgents } from '@agent/index/agentRegistry';
import type { AgentEntry } from '@agent/index/agentEntry';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import { decideRunModel } from '@model/runModelDecision';
import { Secrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type {
  AgentDelegationScope,
  ModelOptionData,
  ToolDefinition,
} from '@shared/schemas';
import { AgentCategory, isModelOptionAvailable } from '@shared/schemas';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { unique } from '@utils/core';
import { isWorktreeSupportEnabled } from '@utils/config/worktreeConfig';

/**
 * Replace `pattern`'s match in a delegation tool's description with
 * `replacement`, returning a new definition. Non-delegation tools and tools
 * without a description are returned untouched.
 *
 * When the pattern does not match:
 *   - `appendIfMissing: true` appends the block as a trailing paragraph.
 *   - `appendIfMissing: false` leaves the description unchanged (replace-only,
 *     for annotations that must never be added where the anchor is absent).
 *
 * `replacement` may be a thunk so the caller can defer any config/registry read
 * until the tool is confirmed to need the block (matched, or appended).
 */
function replaceDelegationDescriptionBlock(
  tool: ToolDefinition,
  pattern: RegExp,
  replacement: string | (() => string),
  { appendIfMissing }: { appendIfMissing: boolean },
): ToolDefinition {
  if (!DELEGATION_TOOLS.has(tool.name) || !tool.description) return tool;

  const matched = pattern.test(tool.description);
  if (!matched && !appendIfMissing) return tool;

  const text = typeof replacement === 'function' ? replacement() : replacement;
  const description = matched
    ? tool.description.replace(pattern, () => text)
    : `${tool.description}\n\n${text}`;
  return { ...tool, description };
}

/* -------------------------------------------------------------------------
 * Agents
 * ---------------------------------------------------------------------- */

/** Matches the "Available agents:" header plus its contiguous (non-blank) list
 * lines, stopping at the first blank line or end of string. Anchored to a line
 * start so it can't match the substring inside surrounding prose. Terminating on
 * a non-blank run (rather than a `(?=\n\n)` lookahead) means a block at the very
 * end of a description still matches, so it is replaced rather than duplicated. */
const AVAILABLE_AGENTS_BLOCK = /^Available agents:.*(?:\n(?!\n).+)*/m;

const NO_AGENTS_LINE =
  'Available agents: none are currently in the active roster. Ask the user to enable delegation targets in Settings → Agents before delegating.';

/**
 * Format an agent list for a delegation tool's "Available agents:" block.
 *
 * Newlines inside a description are collapsed to single spaces so each agent
 * stays one paragraph — a blank line in a (e.g. user- or remote-defined)
 * description would otherwise look like the end of the block to a reader or
 * the block regex.
 */
function formatAgentList(
  agents: readonly { name: string; description?: string; tools?: string[] }[],
): string {
  return agents
    .map((agent) => {
      const desc = (agent.description || 'No description').replaceAll(
        /\s*\n\s*/g,
        ' ',
      );
      const toolsSuffix = agent.tools?.length
        ? `\n  Tools: ${agent.tools.join(', ')}`
        : '';
      return `- ${agent.name}: ${desc}${toolsSuffix}`;
    })
    .join('\n');
}

/**
 * Build the "Available agents:" block for a delegation tool's category from the
 * currently visible roster. An empty roster yields a single actionable line
 * rather than a bare header, mirroring the empty-state messaging on the models
 * line. Annotation runs inside an agent flow that has already loaded the
 * registry, so an empty result means the user genuinely has no visible agents
 * in this category — not a not-yet-loaded cache.
 */
function visibleDelegationAgentsBlock(agents: readonly AgentEntry[]): string {
  if (agents.length === 0) return NO_AGENTS_LINE;
  return `Available agents:\n${formatAgentList(agents)}`;
}

/**
 * The annotation facts that depend on where the reader is standing: the run's
 * pinned delegation scope, the worktree opt-in, and the slots the durable
 * roster answers from — all of them the calling session's, carried as data so
 * the annotation itself is pure over them.
 */
export interface DelegationAnnotationState {
  readonly worktreeEnabled: boolean;
  readonly agents: Readonly<Record<AgentCategory, readonly AgentEntry[]>>;
}

/** Resolve the roster and workspace setting before pure annotation. */
export const readDelegationAnnotationState = Effect.fn(
  'readDelegationAnnotationState',
)(function* (stores: SettingsStores, delegationScope?: AgentDelegationScope) {
  const agents = yield* Effect.all({
    workflow: resolveDelegationScopeAgents(
      stores,
      delegationScope,
      AgentCategory.Workflow,
    ),
    toolUse: resolveDelegationScopeAgents(
      stores,
      delegationScope,
      AgentCategory.ToolUse,
    ),
  });
  return {
    agents,
    worktreeEnabled: yield* isWorktreeSupportEnabled(stores),
  } satisfies DelegationAnnotationState;
});

/* -------------------------------------------------------------------------
 * Models
 * ---------------------------------------------------------------------- */

const AVAILABLE_MODELS_LINE = /^Available models:.*$/m;

const NO_DELEGATION_MODELS_MESSAGE =
  'No models are currently available for delegation. Review or configure model access before delegating.';

export function availableModelNamesFromOptions(
  models: readonly ModelOptionData[],
): string[] {
  return models.filter(isModelOptionAvailable).map((model) => model.value);
}

function formatAvailableModelsLine(
  modelNames: readonly string[] | null,
): string {
  if (modelNames === null) {
    return 'Available models: unavailable to load; omit model unless the user explicitly requested one.';
  }
  if (modelNames.length === 0) {
    return 'Available models: none currently available. Ask the user to configure model access before delegating.';
  }
  return `Available models: ${modelNames.join(', ')}`;
}

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
   * approved proposal, a workflow script's per-call model routing — hand in
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
    availableModelNamesFromOptions(models)
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
    (model) => availableModels.includes(model),
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

/* -------------------------------------------------------------------------
 * Worktree support
 * ---------------------------------------------------------------------- */

/** The single "Git worktree support:" line, anchored to a line start. */
const WORKTREE_LINE = /^Git worktree support:.*$/m;

const WORKTREE_ENABLED_LINE =
  'Git worktree support: ENABLED. Pass `working_directory` (absolute path) to run a subagent rooted in a git worktree; every tool call in the subagent resolves paths against that directory. The subagent reports its working directory back in its delivery result.';

const WORKTREE_DISABLED_LINE =
  'Git worktree support: DISABLED in this workspace. Do not pass `working_directory` because the call will be rejected when the tool runs. Ask the user to turn on `texra.git.worktreeSupport` ("Subagent worktrees" on the Multi-Agent settings tab) if worktree operation is needed.';

/* -------------------------------------------------------------------------
 * Annotation
 * ---------------------------------------------------------------------- */

/**
 * Refresh a delegation tool's "Available models:", "Available agents:", and
 * "Git worktree support:" lines from current state. A tool declaring no
 * `availabilityCategory` returns untouched at the early guard.
 * `availableModelNames` is `undefined` only when the resolved list held no
 * delegation tool at all, so in that case every tool reaching this function is a
 * non-delegation tool that returns early — `category` and `availableModelNames`
 * are independent (one keys off the tool name, the other off the whole list),
 * not causally linked.
 *
 * The roster slots, the roster scope and the worktree switch arrive as `state`
 * rather than being read here — see {@link readDelegationAnnotationState} for
 * why the caller resolves them — so everything below is pure over its
 * arguments.
 *
 * The roster block is appended when its anchor is missing; the worktree line is
 * replace-only, because a tool without that line (e.g. delegate_workflow, which
 * has no `working_directory`) takes no working directory and must never be told
 * it does. The tool rejects a `working_directory` it cannot use when it runs
 * (`rejectUnusableWorkingDirectory`); this only keeps the guidance in step
 * with that check. A `$` in an agent description (e.g. inline LaTeX math) stays
 * literal.
 */
export function annotateDelegationAvailability(
  tool: ToolDefinition,
  availableModelNames: readonly string[] | null | undefined,
  state: DelegationAnnotationState,
): ToolDefinition {
  const category = tool.availabilityCategory;
  if (!category) return tool;
  const withModels =
    availableModelNames === undefined
      ? tool
      : replaceDelegationDescriptionBlock(
          tool,
          AVAILABLE_MODELS_LINE,
          () => formatAvailableModelsLine(availableModelNames),
          { appendIfMissing: true },
        );
  // The replacements no-op without a description, and resolving the roster /
  // worktree state reaches platform state — skip those lookups when there is
  // nothing to annotate (e.g. a tool config that carries only a name).
  if (!withModels.description) return withModels;
  const withAgents = replaceDelegationDescriptionBlock(
    withModels,
    AVAILABLE_AGENTS_BLOCK,
    () => visibleDelegationAgentsBlock(state.agents[category]),
    { appendIfMissing: true },
  );
  return replaceDelegationDescriptionBlock(
    withAgents,
    WORKTREE_LINE,
    () =>
      state.worktreeEnabled ? WORKTREE_ENABLED_LINE : WORKTREE_DISABLED_LINE,
    { appendIfMissing: false },
  );
}
