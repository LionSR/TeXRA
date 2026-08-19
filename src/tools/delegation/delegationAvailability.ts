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

// Local imports
import {
  findAgentByIdentifier,
  resolveDelegationScopeAgents,
} from '@agent/index/agentRegistry';
import type { AgentEntry } from '@agent/index/agentEntry';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { decideRunModel } from '@model/runModelDecision';
import type {
  AgentCategory,
  AgentDelegationScope,
  ModelOptionData,
  ToolDefinition,
} from '@shared/schemas';
import { isModelOptionAvailable } from '@shared/schemas';
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
export function replaceDelegationDescriptionBlock(
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

/** How an agent's tool list is rendered inside a roster entry. */
type AgentListToolsStyle = 'block' | 'inline' | 'none';

interface FormatAgentListOptions {
  /** Where an agent's tool list goes when present. Defaults to `'block'`. */
  readonly tools?: AgentListToolsStyle;
  /** Collapse newlines inside descriptions to spaces. Defaults to `true`. */
  readonly collapseDescriptionNewlines?: boolean;
}

/**
 * Format an agent list for a delegation roster (tool descriptions and
 * prompt-template agent vars share this one formatter so the copy can't drift).
 *
 * For tool descriptions newlines inside a description are collapsed to single
 * spaces so each agent stays one paragraph — a blank line in a (e.g. user- or
 * remote-defined) description would otherwise look like the end of the
 * "Available agents:" block to a reader or the block regex. Prompt-template
 * rendering passes `collapseDescriptionNewlines: false` because the prompt
 * needs the description verbatim.
 */
export function formatAgentList(
  agents: { name: string; description?: string; tools?: string[] }[],
  options: FormatAgentListOptions = {},
): string {
  const { tools = 'block', collapseDescriptionNewlines = true } = options;
  return agents
    .map((agent) => {
      const desc = collapseDescriptionNewlines
        ? (agent.description || 'No description').replaceAll(/\s*\n\s*/g, ' ')
        : agent.description || 'No description';
      let toolsSuffix = '';
      if (tools !== 'none' && agent.tools?.length) {
        toolsSuffix =
          tools === 'inline'
            ? ` [${agent.tools.join(', ')}]`
            : `\n  Tools: ${agent.tools.join(', ')}`;
      }
      return `- ${agent.name}: ${desc}${toolsSuffix}`;
    })
    .join('\n');
}

/**
 * Build the "Available agents:" block for a delegation tool's category from the
 * currently visible roster. An empty roster yields a single actionable line
 * rather than a bare header, mirroring the empty-state messaging on the models
 * line. The only caller, `resolveAgentTools`, runs inside an agent flow that
 * has already loaded the registry, so an empty result means the user genuinely
 * has no visible agents in this category — not a not-yet-loaded cache.
 */
export function visibleDelegationAgentsBlock(category: AgentCategory): string {
  const agents = getDelegationAgents(category);
  if (agents.length === 0) return NO_AGENTS_LINE;
  return `Available agents:\n${formatAgentList(agents)}`;
}

function activeDelegationScope(): AgentDelegationScope | undefined {
  const context = tryUseRunContext();
  return context?.kind === 'launch'
    ? (context.runScope.delegationAgentScope ?? undefined)
    : undefined;
}

/**
 * Resolve delegation targets from an explicitly captured scope, or — when none
 * is supplied — the active run scope, falling back to the durable roster.
 */
export function getDelegationAgents(
  category: AgentCategory,
  scope?: AgentDelegationScope,
): AgentEntry[] {
  return resolveDelegationScopeAgents(
    scope ?? activeDelegationScope(),
    category,
  );
}

/** Resolve one delegation target out of that same candidate set. */
export function getDelegationAgent(
  category: AgentCategory,
  identifier: string,
  scope?: AgentDelegationScope,
): AgentEntry | undefined {
  return findAgentByIdentifier(
    getDelegationAgents(category, scope),
    identifier,
  );
}

/**
 * Replace the "Available agents:" block in a delegation tool's description with
 * the supplied block, appending it when the description has no such block yet.
 * A `$` in an agent description (e.g. inline LaTeX math) stays literal.
 */
export function withDelegationAgentAvailability(
  tool: ToolDefinition,
  agentsBlock: string,
): ToolDefinition {
  return replaceDelegationDescriptionBlock(
    tool,
    AVAILABLE_AGENTS_BLOCK,
    agentsBlock,
    {
      appendIfMissing: true,
    },
  );
}

/* -------------------------------------------------------------------------
 * Models
 * ---------------------------------------------------------------------- */

const AVAILABLE_MODELS_LINE = /^Available models:.*$/m;

const NO_DELEGATION_MODELS_MESSAGE =
  'No models are currently available for delegation in the active API mode. Switch API mode or configure a provider API key before delegating.';

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

export function selectDelegationModelFromAvailableNames(input: {
  readonly requestedModel?: string | null;
  readonly parentModel?: string | null;
  readonly availableModels: readonly string[];
}): string {
  const availableModels = unique(
    input.availableModels.map((model) => model.trim()).filter(Boolean),
  );
  if (availableModels.length === 0) {
    throw new Error(NO_DELEGATION_MODELS_MESSAGE);
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
    throw new Error(NO_DELEGATION_MODELS_MESSAGE);
  }
  if (decision.unavailable) {
    const requestedModel = input.requestedModel?.trim() || null;
    throw new Error(
      `Model "${requestedModel}" is not currently available for delegation in the active API mode. Available models: ${availableModels.join(', ')}.`,
    );
  }
  return decision.model;
}

export function withDelegationModelAvailability(
  tool: ToolDefinition,
  modelNames: readonly string[] | null,
): ToolDefinition {
  return replaceDelegationDescriptionBlock(
    tool,
    AVAILABLE_MODELS_LINE,
    () => formatAvailableModelsLine(modelNames),
    { appendIfMissing: true },
  );
}

/* -------------------------------------------------------------------------
 * Worktree support
 * ---------------------------------------------------------------------- */

/** The single "Git worktree support:" line, anchored to a line start. */
const WORKTREE_LINE = /^Git worktree support:.*$/m;

const WORKTREE_ENABLED_LINE =
  'Git worktree support: ENABLED. Pass `working_directory` (absolute path) to run a subagent rooted in a git worktree; every tool call in the subagent resolves paths against that directory. The subagent reports its working directory back in its delivery result.';

const WORKTREE_DISABLED_LINE =
  'Git worktree support: DISABLED in this workspace. Do not pass `working_directory` because it will be rejected at schema validation. Ask the user to turn on `texra.git.worktreeSupport` ("Allow agents to work in git worktrees" on the Multi-Agent settings tab) if worktree operation is needed.';

/**
 * Replace the "Git worktree support:" line of a delegation tool's description
 * with the line for the current workspace setting. Tools without that line
 * (and non-delegation tools, and tools without a description) are returned
 * untouched, and the worktree setting is read only when the line is present.
 *
 * Unlike the roster annotation, this one is replace-only: a tool without a
 * "Git worktree support:" line (e.g. delegate_workflow, which has no
 * working_directory) takes no working directory, so a line must never be
 * appended to it. The schema's `working_directory` field already enforces the
 * real state at validation time; this only keeps the guidance in step with it.
 */
export function withDelegationWorktreeAvailability(
  tool: ToolDefinition,
): ToolDefinition {
  return replaceDelegationDescriptionBlock(
    tool,
    WORKTREE_LINE,
    () =>
      isWorktreeSupportEnabled()
        ? WORKTREE_ENABLED_LINE
        : WORKTREE_DISABLED_LINE,
    { appendIfMissing: false },
  );
}
