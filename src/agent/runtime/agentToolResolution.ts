/**
 * Agent tool resolution — single source of truth for the effective tool list.
 *
 * The pipeline, in order:
 *   1. Start with the tool names declared in the agent YAML.
 *   2. Strip approval-gated tools when approval prompts are unavailable
 *      (e.g. a subagent running without an interactive approval channel).
 *   3. Strip user-disabled tools (settings dashboard toggle).
 *   4. Strip tools whose external dependency is unavailable (probed at startup).
 *   5. Auto-inject conditional tools (memory, goal, etc.) registered at startup;
 *      injected tools are subject to the approval gate but bypass the
 *      disabled/unavailable filters (they are runtime infrastructure, not
 *      user-selectable tools).
 *   6. Annotate delegation tools with the models and agents currently available
 *      for delegation, so the model sees an accurate "Available models:" line
 *      and an "Available agents:" roster instead of a snapshot frozen when the
 *      tool registry was first constructed.
 *
 * Routine filtering outcomes (disabled, unavailable, not in registry) are
 * intentionally silent — YAML typos are surfaced once at load time by
 * `resolveToolDefinitions`; tools with missing external dependencies are
 * skipped quietly and stay inactive until set up (no toast on each cycle).
 */

import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import * as logUtils from '@logger/logUtils';
import type { ToolDefinition } from '@model/ToolDefinition';
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { AgentCategory } from '@shared/schemas/agent';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { getDefaultToolRegistry } from '@tools/registry';
import {
  getDisabledToolNames,
  getUnavailableToolNamesCached,
} from '@tools/toolAvailability';
import { withoutDiagnosticsAddCommand } from '@tools/DiagnosticsTool';
import {
  DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
  DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
} from '@tools/diagnosticsRuntimeCapabilities';
import {
  availableModelNamesFromOptions,
  visibleDelegationAgentsBlock,
  withDelegationAgentAvailability,
  withDelegationModelAvailability,
  withDelegationWorktreeAvailability,
} from '@tools/delegation/delegationAvailability';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  SharedToolInjectionRegistry,
  type ToolInjectionRegistry,
} from './toolInjection';

export interface ResolveAgentToolsInput {
  tools: AgentToolUseSetting['tools'];
  /** Registry to resolve tool definitions from. Defaults to the global registry. */
  registry?: IToolRegistry;
  logger: { warn: (msg: string) => void };
  /** When true, approval-gated tools are filtered out before model invocation. */
  approvalPromptsUnavailable?: boolean;
  /** Tools unavailable because the current host/runtime cannot support them. */
  runtimeUnavailableTools?: readonly string[];
  /** Conditional runtime tool injections. Defaults to the shared registry. */
  toolInjections?: ToolInjectionRegistry;
}

export interface ResolvedAgentTools {
  tools: ToolDefinition[];
}

/**
 * Probe the models currently available for delegation, but only when the
 * resolved tool list actually contains a delegation tool.
 *
 * Returns `undefined` when no delegation tool is present (nothing to annotate),
 * `null` when the model options could not be loaded, and the list of available
 * model names otherwise.
 */
async function availableDelegationModelNamesForTools(
  tools: readonly ToolDefinition[],
): Promise<ReadonlyMap<AgentCategory, readonly string[]> | null | undefined> {
  if (!hasDelegationTool(tools.map((tool) => tool.name))) {
    return undefined;
  }
  const categories = new Set(
    tools
      .map((tool) => tool.availabilityCategory)
      .filter((category): category is AgentCategory => category !== undefined),
  );

  try {
    const entries = await Promise.all(
      [...categories].map(async (category) => {
        const models = await computeModelOptionsData(undefined, undefined, {
          agentCategory: category,
        });
        return [category, availableModelNamesFromOptions(models)] as const;
      }),
    );
    return new Map(entries);
  } catch (err) {
    // Couldn't load model options — skip the delegation annotation rather than
    // fail the run, but log so the missing "Available models:" line is traceable.
    logUtils.warn(
      'AgentToolResolution',
      `Could not load model options for delegation annotation: ${toErrorMessage(
        err,
      )}`,
    );
    return null;
  }
}

/**
 * Resolve the effective tool list for a single agent run.
 *
 * Called once per tool-use flow invocation. The registry is passed explicitly
 * so callers can substitute a test registry; it defaults to the singleton
 * returned by `getDefaultToolRegistry()`.
 */
export async function resolveAgentTools({
  tools,
  registry,
  logger,
  approvalPromptsUnavailable,
  runtimeUnavailableTools,
  toolInjections = SharedToolInjectionRegistry,
}: ResolveAgentToolsInput): Promise<ResolvedAgentTools> {
  const effectiveRegistry = registry ?? getDefaultToolRegistry();
  const disabled = getDisabledToolNames();
  const unavailable = getUnavailableToolNamesCached();
  const runtimeUnavailable = new Set(runtimeUnavailableTools ?? []);
  const diagnosticsReadUnavailable = runtimeUnavailable.has(
    DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
  );
  const diagnosticsAddUnavailable =
    !diagnosticsReadUnavailable &&
    runtimeUnavailable.has(DIAGNOSTICS_ADD_RUNTIME_CAPABILITY);

  const toolConfigs = Array.isArray(tools) ? tools : [];

  /** Runtime-availability and approval gates shared by declared and injected tools. */
  const passesRuntimeGates = (name: string): boolean => {
    if (runtimeUnavailable.has(name)) return false;
    return (
      approvalPromptsUnavailable !== true ||
      effectiveRegistry.get(name)?.requiresApproval !== true
    );
  };

  const resolved: ToolDefinition[] = [];
  const resolvedNames = new Set<string>();
  for (const config of toolConfigs) {
    const def = typeof config === 'string' ? { name: config } : config;
    if (!passesRuntimeGates(def.name)) continue;
    if (disabled.has(def.name)) continue;
    if (unavailable.has(def.name)) continue;
    if (!effectiveRegistry.has(def.name)) continue;
    resolved.push(runtimeNarrowToolDefinition(def, diagnosticsAddUnavailable));
    resolvedNames.add(def.name);
  }
  for (const injection of toolInjections.list()) {
    if (!injection.shouldInject()) continue;
    if (resolvedNames.has(injection.toolName)) continue;
    if (!passesRuntimeGates(injection.toolName)) continue;
    const tool = effectiveRegistry.get(injection.toolName);
    if (tool) {
      resolved.push(
        runtimeNarrowToolDefinition(tool.definition, diagnosticsAddUnavailable),
      );
      resolvedNames.add(injection.toolName);
    } else {
      logger.warn(`Injected tool not found in registry: ${injection.toolName}`);
    }
  }

  const availableModelNames =
    await availableDelegationModelNamesForTools(resolved);
  return {
    tools: resolved.map((tool) =>
      annotateDelegationTool(tool, availableModelNames),
    ),
  };
}

function runtimeNarrowToolDefinition(
  tool: ToolDefinition,
  diagnosticsAddUnavailable: boolean,
): ToolDefinition {
  return diagnosticsAddUnavailable ? withoutDiagnosticsAddCommand(tool) : tool;
}

/**
 * Refresh a delegation tool's "Available models:", "Available agents:", and
 * "Git worktree support:" lines from current state. A tool declaring no
 * `availabilityCategory` returns untouched at the early guard.
 * `availableModelNames` is `undefined` only when the resolved list held no
 * delegation tool at all, so in that case every tool reaching this function is a
 * non-delegation tool that returns early — `category` and `availableModelNames`
 * are independent (one keys off the tool name, the other off the whole list),
 * not causally linked.
 */
function annotateDelegationTool(
  tool: ToolDefinition,
  availableModelNames:
    ReadonlyMap<AgentCategory, readonly string[]> | null | undefined,
): ToolDefinition {
  const category = tool.availabilityCategory;
  if (!category) return tool;
  const categoryModelNames =
    availableModelNames instanceof Map
      ? (availableModelNames.get(category) ?? [])
      : availableModelNames;
  const withModels =
    availableModelNames === undefined
      ? tool
      : withDelegationModelAvailability(tool, categoryModelNames);
  // The annotators no-op without a description, and resolving the roster /
  // worktree state reaches platform state — skip those lookups when there is
  // nothing to annotate (e.g. a tool config that carries only a name).
  if (!withModels.description) return withModels;
  const withAgents = withDelegationAgentAvailability(
    withModels,
    visibleDelegationAgentsBlock(category),
  );
  return withDelegationWorktreeAvailability(withAgents);
}
