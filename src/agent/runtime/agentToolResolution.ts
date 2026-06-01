/**
 * Agent tool resolution — single source of truth for the effective tool list.
 *
 * The pipeline, in order:
 *   1. Start with the tool names declared in the agent YAML.
 *   2. Strip delegation tools when the nesting depth limit is reached.
 *   3. Strip approval-gated tools when approval prompts are unavailable
 *      (e.g. a subagent running without an interactive approval channel).
 *   4. Strip user-disabled tools (settings dashboard toggle).
 *   5. Strip tools whose external dependency is unavailable (probed at startup).
 *   6. Auto-inject conditional tools (memory, odyssey, etc.) registered at startup;
 *      injected tools are subject to delegation and approval gates but bypass
 *      the disabled/unavailable filters (they are runtime infrastructure, not
 *      user-selectable tools).
 *   7. Annotate delegation tools with the models currently available for
 *      delegation, so the model sees an accurate "Available models:" line.
 *
 * Routine filtering outcomes (disabled, unavailable, not in registry) are
 * intentionally silent — YAML typos are surfaced once at load time by
 * `resolveToolDefinitions`; missing external dependencies are surfaced via
 * `notifyUnavailableTools` below, not repeated on every cycle.
 */

import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import type { ToolDefinition } from '@model';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { getDefaultToolRegistry } from '@tools/registry';
import {
  getDisabledToolNames,
  getUnavailableToolNamesCached,
} from '@tools/toolAvailability';
import { notifyUnavailableTools } from '@tools/toolUnavailableNotification';
import {
  availableModelNamesFromOptions,
  withDelegationModelAvailability,
} from '@tools/delegationModelAvailability';
import { isApprovalGatedToolName } from '@tools/approvalGatedTools';
import { listToolInjections } from './toolInjection';

export interface ResolveAgentToolsInput {
  tools: AgentToolUseSetting['tools'];
  /** Registry to resolve tool definitions from. Defaults to the global registry. */
  registry?: IToolRegistry;
  logger: { warn: (msg: string) => void };
  /** When true, delegation tools (delegate_workflow, delegate_agent) are excluded. */
  delegationBlocked: boolean;
  /** When true, approval-gated tools are filtered out before model invocation. */
  approvalPromptsUnavailable?: boolean;
}

export interface ResolvedAgentTools {
  tools: ToolDefinition[];
  /** True if at least one delegation tool was removed due to depth limits. */
  delegationTrimmed: boolean;
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
): Promise<readonly string[] | null | undefined> {
  if (!tools.some((tool) => DELEGATION_TOOLS.has(tool.name))) {
    return undefined;
  }

  try {
    return availableModelNamesFromOptions(await computeModelOptionsData());
  } catch {
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
  delegationBlocked,
  approvalPromptsUnavailable,
}: ResolveAgentToolsInput): Promise<ResolvedAgentTools> {
  const effectiveRegistry = registry ?? getDefaultToolRegistry();
  const disabled = getDisabledToolNames();
  const unavailable = getUnavailableToolNamesCached();
  const missingDependency: string[] = [];

  const toolConfigs = Array.isArray(tools) ? tools : [];
  let delegationTrimmed = false;

  const resolved: ToolDefinition[] = [];
  const resolvedNames = new Set<string>();
  for (const config of toolConfigs) {
    const def = typeof config === 'string' ? { name: config } : config;
    if (DELEGATION_TOOLS.has(def.name) && delegationBlocked) {
      delegationTrimmed = true;
      continue;
    }
    if (
      approvalPromptsUnavailable === true &&
      isApprovalGatedToolName(def.name)
    ) {
      continue;
    }
    if (disabled.has(def.name)) continue;
    if (unavailable.has(def.name)) {
      missingDependency.push(def.name);
      continue;
    }
    if (!effectiveRegistry.has(def.name)) continue;
    resolved.push(def);
    resolvedNames.add(def.name);
  }
  for (const injection of listToolInjections()) {
    if (!injection.shouldInject()) continue;
    if (resolvedNames.has(injection.toolName)) continue;
    if (DELEGATION_TOOLS.has(injection.toolName) && delegationBlocked) {
      delegationTrimmed = true;
      continue;
    }
    if (
      approvalPromptsUnavailable === true &&
      isApprovalGatedToolName(injection.toolName)
    ) {
      continue;
    }
    const tool = effectiveRegistry.get(injection.toolName);
    if (tool) {
      resolved.push(tool.definition);
      resolvedNames.add(injection.toolName);
    } else {
      logger.warn(`Injected tool not found in registry: ${injection.toolName}`);
    }
  }

  if (missingDependency.length) {
    notifyUnavailableTools(missingDependency);
  }

  const availableModelNames =
    await availableDelegationModelNamesForTools(resolved);
  return {
    tools:
      availableModelNames === undefined
        ? resolved
        : resolved.map((tool) =>
            withDelegationModelAvailability(tool, availableModelNames),
          ),
    delegationTrimmed,
  };
}
