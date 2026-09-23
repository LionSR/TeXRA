/**
 * Agent tool resolution — single source of truth for the effective tool list.
 *
 * A run's tools come from its composition (`@tools/composition`), a value:
 * the plugins still on (the user's dashboard switches and the dependency
 * probes applied), the host and approval gates, the agent's declared tools
 * and the tools the manifest injects while their setting is on (none for
 * reflection). The offered registry is rebuilt from the composition's plugin
 * list over the process's `ToolRegistry` table, in this order:
 *   1. The declared tools, in declaration order, each with the table's own
 *      contract (description, parameter schema). A tool the host cannot run
 *      (its `unavailableHosts`; every such tool when no host was named) or
 *      that is approval-gated while approval prompts are unavailable is
 *      withheld, then one whose plugin is off.
 *   2. The injected tools not already declared, under the same host and
 *      approval gates.
 *   3. Delegation tools annotated with the models and agents currently
 *      available for delegation, so the model sees an accurate "Available
 *      models:" line and an "Available agents:" roster.
 *   4. The run's own tools (caller-supplied, and the structured-output
 *      terminal tool) laid over the result: each is force-called, replaces a
 *      same-named entry, and wins the name in the returned registry. That
 *      registry holds the offered tools only, so dispatch cannot run a tool
 *      the model was not offered.
 *
 * Routine filtering outcomes (switched off, dependency missing) are
 * intentionally silent; those tools stay inactive until set up (no toast on
 * each cycle). A declared name the table does not hold is the one reported
 * case.
 */

import { Effect } from 'effect';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { MapToolRegistry, type ToolHost } from '@agent/core/tools/ToolTypes';
import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import { withLogChannel } from '@logger/effectLog';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import type { AgentDelegationScope, ToolDefinition } from '@shared/schemas';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { compositionFor } from '@tools/composition';
import { findToolPlugin } from '@tools/plugins';
import { getUnavailableToolNamesCached } from '@tools/toolAvailability';
import { ToolRegistry } from '@tools/toolTable';
import {
  annotateDelegationAvailability,
  availableModelNamesFromOptions,
  readDelegationAnnotationState,
} from '@tools/delegation/delegationAvailability';
import { getDisabledToolIds } from '@utils/config/constants';
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'AgentToolResolution';

interface ResolveAgentToolsInput {
  tools: AgentToolUseSetting['tools'];
  logger: { warn: (msg: string) => void };
  /** When true, approval-gated tools are filtered out before model invocation. */
  approvalPromptsUnavailable?: boolean;
  /**
   * The product host this process is; tools excluded from it are dropped.
   * `undefined` (no composition root named one) drops every host-bound tool.
   */
  host: ToolHost | undefined;
  /** Tools only this run holds, laid over the resolved list (step 4). */
  runTools?: readonly ITool[];
  /** Whether the manifest's injected tools join (step 2); not for reflection. */
  injectTools: boolean;
  /**
   * The run's stores: the session's three setting slots, which the injections'
   * settings, the user's disabled-tool set and the delegation annotation's
   * worktree opt-in read, and the secret store behind the delegation roster's
   * model availability.
   */
  stores: ModelOptionStores;
  /** The run's workspace root: the tool-availability probes answer per workspace. */
  workspaceRoot: string | undefined;
  /** The run's pinned delegation roster scope, when this is a delegated run. */
  delegationScope?: AgentDelegationScope;
}

/**
 * Probe the models currently available for delegation, but only when the
 * resolved tool list actually contains a delegation tool.
 *
 * Returns `undefined` when no delegation tool is present (nothing to annotate),
 * `null` when the model options could not be loaded, and the list of available
 * model names otherwise.
 */
function availableDelegationModelNamesForTools(
  tools: readonly ToolDefinition[],
  stores: ModelOptionStores,
): Effect.Effect<readonly string[] | null | undefined, never, LanguageModel> {
  if (!hasDelegationTool(tools.map((tool) => tool.name))) {
    return Effect.succeed(undefined);
  }

  return readModelAvailabilityInputs(stores).pipe(
    Effect.map((inputs) =>
      availableModelNamesFromOptions(modelOptionsFrom(inputs)),
    ),
    // A failed read (an unreadable store, a host call that rejected) degrades:
    // skip the delegation annotation rather than fail the run, and log so the
    // missing "Available models:" line is traceable. `Effect.catch` recovers
    // typed failures only, which is the whole distinction — the pure finisher's
    // "provider key status was never read" invariant is a programming error, so
    // it surfaces as a defect and fails the run rather than being logged as a
    // degraded annotation.
    Effect.catch((error) =>
      Effect.logWarning(
        `Could not load model options for delegation annotation: ${toErrorMessage(error)}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as(null)),
    ),
  );
}

/**
 * Resolve the effective tool list for a single agent run: its composition,
 * and the offered definitions and registry built from it.
 */
export const resolveAgentTools = Effect.fn('resolveAgentTools')(function* ({
  tools,
  logger,
  approvalPromptsUnavailable = false,
  host,
  runTools = [],
  injectTools,
  stores,
  workspaceRoot,
  delegationScope,
}: ResolveAgentToolsInput) {
  const table = yield* ToolRegistry;
  const injected: string[] = [];
  if (injectTools) {
    for (const id of table.plugins.keys()) {
      const injections = findToolPlugin(id)?.injectedWhen ?? {};
      for (const [name, setting] of Object.entries(injections)) {
        if (yield* readSettingFrom<boolean>(stores, setting)) {
          injected.push(name);
        }
      }
    }
  }
  const composition = compositionFor({
    table,
    disabledIds: yield* getDisabledToolIds(stores.globalState),
    unavailableTools: getUnavailableToolNamesCached(workspaceRoot),
    host,
    approvalPromptsUnavailable,
    tools: (Array.isArray(tools) ? tools : []).map((toolConfig) =>
      typeof toolConfig === 'string' ? toolConfig : toolConfig.name,
    ),
    injected,
  });
  // The tools the composition may offer, rebuilt from its plugin list.
  const enabled = new Map(
    composition.plugins.flatMap((id) => [...(table.plugins.get(id) ?? [])]),
  );

  /** The host and approval gates, shared by declared and injected tools. */
  const passesRuntimeGates = (name: string): boolean => {
    const tool = table.get(name);
    const excluded = tool?.unavailableHosts ?? [];
    if (excluded.length > 0 && host === undefined) {
      logger.warn(
        `Tool "${name}" is not offered: it depends on the product host, and this process named none.`,
      );
      return false;
    }
    if (host !== undefined && excluded.includes(host)) return false;
    return !approvalPromptsUnavailable || !tool?.requiresApproval;
  };

  const resolved: ToolDefinition[] = [];
  const resolvedNames = new Set<string>();
  for (const name of composition.tools) {
    if (!passesRuntimeGates(name)) continue;
    const tool = enabled.get(name);
    if (!tool) {
      // A declared name with no registration is a configuration error (typo,
      // or a tool retired from the table) — dropping it silently would strip
      // the agent's capability with no trace. One whose plugin is off is
      // withheld quietly.
      if (!table.get(name)) {
        logger.warn(`Declared tool not found in registry: ${name}`);
      }
      continue;
    }
    // The contract the model is shown is the table's own, never one an agent
    // definition carries: a declaration names a tool, it does not redefine it.
    resolved.push(tool.definition);
    resolvedNames.add(name);
  }
  for (const name of composition.injected) {
    if (resolvedNames.has(name)) continue;
    if (!passesRuntimeGates(name)) continue;
    const tool = enabled.get(name);
    if (tool) {
      resolved.push(tool.definition);
      resolvedNames.add(name);
    } else {
      logger.warn(`Injected tool not found in registry: ${name}`);
    }
  }

  const availableModelNames = yield* availableDelegationModelNamesForTools(
    resolved,
    stores,
  );
  // Both facts travel into the pure annotation mapping as data: the worktree
  // opt-in is read from the slots this resolution was given, and the run's
  // pinned delegation scope is already explicit data from AgentRun.
  let definitions = resolved;
  if (availableModelNames !== undefined) {
    const annotationState = yield* readDelegationAnnotationState(
      stores,
      delegationScope,
    );
    definitions = resolved.map((tool) =>
      annotateDelegationAvailability(
        tool,
        availableModelNames,
        annotationState,
      ),
    );
  }
  const overlay = new Map<string, ITool>();
  for (const tool of runTools) {
    const { name } = tool.definition;
    const index = definitions.findIndex((entry) => entry.name === name);
    if (overlay.has(name) || table.get(name) || index !== -1) {
      logger.warn(`Run-scoped tool "${name}" shadows an existing tool.`);
    }
    overlay.set(name, tool);
    if (index === -1) definitions.push(tool.definition);
    else definitions[index] = tool.definition;
  }
  // Dispatch answers only the names the model was offered: a registered tool
  // the run withheld (disabled, undeclared, host-excluded, or gated on an
  // approval prompt this host cannot show) settles as unknown rather than
  // running because the model named it anyway.
  const offered = new Map<string, ITool>();
  for (const { name } of definitions) {
    const tool = overlay.get(name) ?? enabled.get(name);
    if (tool) offered.set(name, tool);
  }
  return {
    definitions,
    registry: new MapToolRegistry(offered),
    composition,
  };
});
