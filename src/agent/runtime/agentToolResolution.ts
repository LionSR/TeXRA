/**
 * Agent tool resolution — single source of truth for the effective tool list.
 *
 * The pipeline, in order:
 *   1. Start with the tool names declared in the agent YAML, and take each
 *      one's contract (description, parameter schema) from the registry.
 *   2. Strip tools the process's product host cannot run (a tool's
 *      `unavailableHosts`; every such tool when no host was named), and approval-gated tools when approval prompts
 *      are unavailable (e.g. a subagent without an interactive channel).
 *   3. Strip user-disabled tools (settings dashboard toggle).
 *   4. Strip tools whose external dependency is unavailable (probed at startup).
 *   5. Auto-inject the process's conditional tools (memory, goal, etc.), which
 *      the caller passes in as data;
 *      injected tools are subject to the approval gate but bypass the
 *      disabled/unavailable filters (they are runtime infrastructure, not
 *      user-selectable tools).
 *   6. Lay the run's own tools (caller-supplied, and the structured-output
 *      terminal tool) over the result: each is force-called, replaces a
 *      same-named entry, and wins the name in the returned registry. That
 *      registry holds the offered tools only, so dispatch cannot run a tool
 *      the model was not offered.
 *   7. Annotate delegation tools with the models and agents currently available
 *      for delegation, so the model sees an accurate "Available models:" line
 *      and an "Available agents:" roster instead of a snapshot frozen when the
 *      tool registry was first constructed.
 *
 * Routine filtering outcomes (disabled, unavailable) are intentionally silent;
 * tools with missing external dependencies are skipped quietly and stay
 * inactive until set up (no toast on each cycle). A declared name the registry
 * does not hold is the one reported case.
 */

import { Effect } from 'effect';

import type {
  RuntimeTool as ITool,
  RuntimeToolRegistry as IToolRegistry,
} from '@agent/runtime/ToolServices';
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
import { getDefaultToolRegistry } from '@tools/registry';
import {
  getDisabledToolNames,
  getUnavailableToolNamesCached,
} from '@tools/toolAvailability';
import {
  annotateDelegationAvailability,
  availableModelNamesFromOptions,
  readDelegationAnnotationState,
} from '@tools/delegation/delegationAvailability';
import { getDisabledToolIds } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { ConditionalToolInjection } from './toolInjection';

const CHANNEL = 'AgentToolResolution';

interface ResolveAgentToolsInput {
  tools: AgentToolUseSetting['tools'];
  /** Registry to resolve tool definitions from. Defaults to the global registry. */
  registry?: IToolRegistry;
  logger: { warn: (msg: string) => void };
  /** When true, approval-gated tools are filtered out before model invocation. */
  approvalPromptsUnavailable?: boolean;
  /**
   * The product host this process is; tools excluded from it are dropped.
   * `undefined` (no composition root named one) drops every host-bound tool.
   */
  host: ToolHost | undefined;
  /** Tools only this run holds, laid over the resolved list (step 6). */
  runTools?: readonly ITool[];
  /** Conditional runtime tool injections (step 5); none for reflection. */
  toolInjections: readonly ConditionalToolInjection[];
  /**
   * The run's stores: the session's three setting slots, which the injections'
   * predicates, the user's disabled-tool set and the delegation annotation's
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
 * Resolve the effective tool list for a single agent run.
 *
 * Called once per tool-use flow invocation. The registry is passed explicitly
 * so callers can substitute a test registry; it defaults to the singleton
 * returned by `getDefaultToolRegistry()`.
 */
export const resolveAgentTools = Effect.fn('resolveAgentTools')(function* ({
  tools,
  registry,
  logger,
  approvalPromptsUnavailable,
  host,
  runTools = [],
  toolInjections,
  stores,
  workspaceRoot,
  delegationScope,
}: ResolveAgentToolsInput) {
  const effectiveRegistry = registry ?? getDefaultToolRegistry();
  const disabled = getDisabledToolNames(
    yield* getDisabledToolIds(stores.globalState),
  );
  const unavailable = getUnavailableToolNamesCached(workspaceRoot);

  const toolConfigs = Array.isArray(tools) ? tools : [];

  /** Runtime-availability and approval gates shared by declared and injected tools. */
  const passesRuntimeGates = (name: string): boolean => {
    const tool = effectiveRegistry.get(name);
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
  for (const toolConfig of toolConfigs) {
    const name = typeof toolConfig === 'string' ? toolConfig : toolConfig.name;
    if (resolvedNames.has(name)) continue;
    if (!passesRuntimeGates(name)) continue;
    if (disabled.has(name)) continue;
    if (unavailable.has(name)) continue;
    const registered = effectiveRegistry.get(name);
    if (!registered) {
      // A declared name with no registration is a configuration error (typo,
      // or a tool retired from the registry) — dropping it silently would
      // strip the agent's capability with no trace.
      logger.warn(`Declared tool not found in registry: ${name}`);
      continue;
    }
    // The contract the model is shown is the registry's own, never one an
    // agent definition carries: a declaration names a tool, it does not
    // redefine it.
    resolved.push(registered.definition);
    resolvedNames.add(name);
  }
  for (const injection of toolInjections) {
    if (!(yield* injection.shouldInject(stores))) continue;
    if (resolvedNames.has(injection.toolName)) continue;
    if (!passesRuntimeGates(injection.toolName)) continue;
    const tool = effectiveRegistry.get(injection.toolName);
    if (tool) {
      resolved.push(tool.definition);
      resolvedNames.add(injection.toolName);
    } else {
      logger.warn(`Injected tool not found in registry: ${injection.toolName}`);
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
    if (overlay.has(name) || effectiveRegistry.has(name) || index !== -1) {
      logger.warn(`Run-scoped tool "${name}" shadows an existing tool.`);
    }
    overlay.set(name, tool);
    const definition = { ...tool.definition, forceFunctionCall: true };
    if (index === -1) definitions.push(definition);
    else definitions[index] = definition;
  }
  // Dispatch answers only the names the model was offered: a registered tool
  // the run withheld (disabled, undeclared, host-excluded, or gated on an
  // approval prompt this host cannot show) settles as unknown rather than
  // running because the model named it anyway.
  const offered = new Map<string, ITool>();
  for (const { name } of definitions) {
    const tool = overlay.get(name) ?? effectiveRegistry.get(name);
    if (tool) offered.set(name, tool);
  }
  return { definitions, registry: new MapToolRegistry(offered) };
});
