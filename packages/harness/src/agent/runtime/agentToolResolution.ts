/**
 * Agent tool resolution — single source of truth for the tools one step
 * offers.
 *
 * A step pins a generation of the process's live tool catalog
 * (`@tools/liveTools`): the tools of every plugin switched on, and of the
 * loaded plugins (MCP servers) some run holds. This module narrows that
 * generation to what the run may be offered, in this order:
 *   1. The declared tools, in declaration order, each with the catalog's own
 *      contract (description, parameter schema). An MCP server's tools
 *      (`mcp__<server>__<tool>`, or `mcp__<server>__*` for all it lists)
 *      come from the loaded plugin the declaration names; a server that is
 *      not configured or failed to start is reported. A tool whose plugin a
 *      dependency probe found missing, that the host cannot run (its
 *      `unavailableHosts`) or that
 *      is approval-gated while approval prompts are unavailable is withheld;
 *      so is one whose plugin is off (not in the generation).
 *   2. The injected tools not already declared, under the same gates: the
 *      plugins' (`injectedWhen`), and every tool of an installed plugin (its
 *      MCP servers'), which the plugin's enablement offers every top-level
 *      tool-use run but a plugin agent that names its tools.
 *   3. A delegated child keeps only the tools its parent's step offered,
 *      with the same identity: it can only narrow its parent, so a tool its
 *      parent was withheld (a switch, a gate, a host) never reaches it.
 *   4. The run's own tools (caller-supplied, and the structured-output
 *      terminal tool) laid over the result: each replaces a same-named
 *      entry and wins the name in the returned registry. That registry holds
 *      the offered tools only, so dispatch cannot run a tool the model was
 *      not offered.
 *
 * A switched-off plugin is withheld silently: the user chose it. The other
 * outcomes, a declared tool whose dependency is missing included, are
 * returned as warnings, which the step reports when
 * the offered set changes, not on every step.
 */

import { Effect, SubscriptionRef } from 'effect';

import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import {
  MapToolRegistry,
  type HostToolCapability,
} from '@agent/core/tools/ToolTypes';
import type { Persona } from '@agent/core/definition/AgentDataclass';
import { isInstalledPluginId } from '@common/plugins/pluginTrust';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { SettingHost } from '@shared/state/stateSettings';
import {
  sameIdentity,
  type OfferedTool,
  type ToolDefinition,
} from '@shared/schemas';
import {
  toolDigests,
  type HeldPlugins,
  type ToolGeneration,
} from '@tools/catalogEntries';
import { mcpPluginId, mcpServerOfToolName } from '@tools/mcp/mcpServer';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';
import { readSettingFrom } from '@utils/config/platformSettings';

/** What a step resolves its tools from: fixed at the run's open, but the
 *  approval flag the step reads live. */
export interface StepToolInputs {
  readonly tools: Persona['tools'];
  /** When true, approval-gated tools are withheld: read live each step. */
  readonly approvalPromptsUnavailable: boolean;
  /** What the session's host serves now, read live each step: a tool that
   *  needs a capability missing here is withheld. */
  readonly hostCapabilities: ReadonlySet<HostToolCapability>;
  /** The product host the run's roots name; tools excluded from it are dropped. */
  readonly host: SettingHost;
  /** Tools only this run holds, laid over the resolved list (step 4). */
  readonly runTools: readonly ITool[];
  /** Whether the plugins' injected tools join (step 2). */
  readonly injectTools: boolean;
  /** Whether the installed plugins' tools join (step 2): a top-level run's,
   *  unless it is a plugin agent that names its own tools. */
  readonly injectInstalled: boolean;
  /** The run's stores, which the injections' settings read. */
  readonly stores: ModelOptionStores;
  /** The run's workspace root: the tool-availability probes answer per
   *  workspace. */
  readonly workspaceRoot: string | undefined;
  /** What the parent's step offered, when this is a delegated child. */
  readonly parentOffered?: readonly OfferedTool[];
  /** The loaded plugins the run holds, from its open. */
  readonly held: HeldPlugins;
}

/** A declaration's tool names, in order. */
export const declaredToolNames = (tools: Persona['tools']): readonly string[] =>
  (Array.isArray(tools) ? tools : []).map((toolConfig) =>
    typeof toolConfig === 'string' ? toolConfig : toolConfig.name,
  );

/**
 * Why a delegated child cannot launch under its parent's offered tools, or
 * `undefined` when it can. A child can only narrow its parent: a built-in
 * tool its parent was not offered is withheld from the child as it is for
 * any run; but a child naming an MCP server none of whose tools its parent
 * was offered asks for more than its parent was given, and is refused
 * before it starts.
 */
export function childToolRefusal(
  parentOffered: readonly OfferedTool[],
  tools: Persona['tools'],
  agentName?: string,
): string | undefined {
  const servers = new Set(
    parentOffered.flatMap(({ name }) => mcpServerOfToolName(name) ?? []),
  );
  const outside = declaredToolNames(tools).flatMap((tool) => {
    const server = mcpServerOfToolName(tool);
    if (server === undefined) return [];
    return servers.has(server) ? [] : [{ tool, server }];
  });
  if (outside.length === 0) return undefined;
  const named = [...new Set(outside.map(({ server }) => `"${server}"`))];
  return [
    `Subagent${agentName ? ` '${agentName}'` : ''} was not launched: it declares ${outside.map(({ tool }) => tool).join(', ')}, from MCP server${named.length > 1 ? 's' : ''} ${named.join(', ')}, which this run's tools do not include.`,
    "A subagent can only narrow its parent's tools: declare the plugin on the parent agent, or delegate to an agent that does not need it.",
  ].join(' ');
}

/** Resolve the tools one step offers from the generation it pinned. */
export const resolveStepTools = Effect.fn('resolveStepTools')(function* (
  generation: ToolGeneration,
  input: StepToolInputs,
) {
  const table = yield* ToolRegistry;
  const warnings: string[] = [];
  const injected: string[] = [];
  if (input.injectTools) {
    for (const { injectedWhen } of table.entries.values()) {
      for (const [name, setting] of Object.entries(injectedWhen ?? {})) {
        if (
          setting === true ||
          (yield* readSettingFrom<boolean>(input.stores, setting))
        ) {
          injected.push(name);
        }
      }
    }
  }
  if (input.injectInstalled)
    for (const [name, entry] of generation.entries)
      if (isInstalledPluginId(entry.plugin)) injected.push(name);
  if (input.parentOffered) {
    const refusal = childToolRefusal(input.parentOffered, input.tools);
    if (refusal !== undefined) return yield* Effect.fail(new Error(refusal));
  }
  // A plugin whose dependency the workspace's last probe found missing is
  // off. Before any probe has answered for the workspace, nothing is
  // withheld on its account.
  const probed =
    (yield* SubscriptionRef.get((yield* ToolAvailability).results)).get(
      input.workspaceRoot,
    ) ?? [];
  const probedOff = new Map(
    probed.flatMap((result) =>
      result.status === 'not-found' ? [[result.id, result] as const] : [],
    ),
  );
  const enabled = new Map(
    [...generation.entries].filter(([, e]) => !probedOff.has(e.plugin)),
  );
  // A child keeps only what its parent's step offered, as the same tool.
  const parent = input.parentOffered
    ? new Map(input.parentOffered.map((tool) => [tool.name, tool]))
    : undefined;
  const narrowed = (name: string): boolean => {
    if (!parent) return true;
    const offered = parent.get(name);
    const entry = enabled.get(name);
    return (
      offered !== undefined &&
      entry !== undefined &&
      sameIdentity(offered, { name, ...entry })
    );
  };

  const withheldForApproval: string[] = [];
  const passesRuntimeGates = (name: string): boolean => {
    const tool = enabled.get(name)?.tool ?? table.get(name);
    const excluded = tool?.unavailableHosts ?? [];
    if (excluded.includes(input.host)) return false;
    if (
      tool?.hostCapability !== undefined &&
      !input.hostCapabilities.has(tool.hostCapability)
    )
      return false;
    if (tool?.requiresApproval && input.approvalPromptsUnavailable) {
      // One whose plugin is off is withheld for that, silently.
      if (enabled.has(name)) withheldForApproval.push(name);
      return false;
    }
    return true;
  };

  // A declared MCP name reaches its server's plugin: `mcp__<server>__*` is
  // every tool the server listed, in its order. A server the run names but
  // could not get (not configured, or failed to start) is reported once.
  const reportedServers = new Set<string>();
  const reportServer = (server: string, message: string): void => {
    if (reportedServers.has(server)) return;
    reportedServers.add(server);
    warnings.push(message);
  };
  const expandDeclared = (name: string): readonly string[] => {
    const server = mcpServerOfToolName(name);
    if (server === undefined) return [name];
    const id = mcpPluginId(server);
    // An installed plugin's server: its tools are in the generation while
    // the plugin loads, and why it does not is the step's to report.
    const installed = [...enabled].flatMap(([toolName, e]) =>
      isInstalledPluginId(e.plugin) && mcpServerOfToolName(toolName) === server
        ? [toolName]
        : [],
    );
    if (installed.length > 0) return name.endsWith('__*') ? installed : [name];
    if (!input.held.loaded.has(id)) {
      reportServer(
        server,
        `MCP server "${server}" is not configured in the MCP config; its tools are not offered.`,
      );
      return [];
    }
    const failure = input.held.loaded.get(id);
    if (failure !== undefined) {
      reportServer(server, `${failure}; its tools are not offered.`);
      return [];
    }
    const serverTools = [...enabled].flatMap(([toolName, e]) =>
      e.plugin === id ? [toolName] : [],
    );
    if (name.endsWith('__*')) return serverTools;
    if (!serverTools.includes(name))
      warnings.push(`MCP server "${server}" lists no tool named ${name}.`);
    return [name];
  };

  const definitions: ToolDefinition[] = [];
  const resolvedNames = new Set<string>();
  const offer = (name: string, source: 'declared' | 'injected'): void => {
    if (resolvedNames.has(name) || !narrowed(name)) return;
    // A missing dependency says so where the run declared the tool, before
    // any other gate, so an approval-gated tool's reason is not lost to the
    // approval notice.
    const missing = probedOff.get(generation.entries.get(name)?.plugin ?? '');
    if (missing !== undefined) {
      if (source === 'declared')
        warnings.push(
          `Tool "${name}" is not offered: its plugin ${missing.id} is not available in this workspace${missing.statusDetail ? ` (${missing.statusDetail})` : ''}.`,
        );
      return;
    }
    if (!passesRuntimeGates(name)) return;
    const entry = enabled.get(name);
    if (!entry) {
      // A name with no registration is a configuration error (typo, or a
      // tool retired from the table): dropping it silently would strip the
      // agent's capability with no trace. One whose plugin is switched off
      // is withheld quietly; an MCP name was reported above.
      if (!table.get(name) && mcpServerOfToolName(name) === undefined)
        warnings.push(
          `${source === 'declared' ? 'Declared' : 'Injected'} tool not found in registry: ${name}`,
        );
      return;
    }
    // The contract the model is shown is the catalog's own: a declaration
    // names a tool, it does not redefine it.
    definitions.push(entry.tool.definition);
    resolvedNames.add(name);
  };
  for (const name of [...new Set(declaredToolNames(input.tools))].flatMap(
    expandDeclared,
  ))
    offer(name, 'declared');
  for (const name of injected) offer(name, 'injected');

  const overlay = new Map<string, ITool>();
  for (const tool of input.runTools) {
    const { name } = tool.definition;
    const index = definitions.findIndex((entry) => entry.name === name);
    if (overlay.has(name) || table.get(name) || index !== -1) {
      warnings.push(`Run-scoped tool "${name}" shadows an existing tool.`);
    }
    overlay.set(name, tool);
    if (index === -1) definitions.push(tool.definition);
    else definitions[index] = tool.definition;
  }
  // Dispatch answers only the names the model was offered.
  const offeredTools = new Map<string, ITool>();
  const offered: OfferedTool[] = [];
  // Recorded as shown: the definition sent.
  for (const definition of definitions) {
    const { name } = definition;
    const own = overlay.get(name);
    const entry = enabled.get(name);
    if (own) {
      // A tool only this run holds; `definition` is its own.
      offeredTools.set(name, own);
      offered.push({
        name,
        ...toolDigests(own),
        plugin: 'run',
        revision: 'run',
      });
    } else if (entry) {
      offeredTools.set(name, entry.tool);
      offered.push({
        name,
        digest: entry.digest,
        shown: toolDigests({ definition }).shown,
        plugin: entry.plugin,
        revision: entry.revision,
      });
    }
  }
  return {
    definitions,
    registry: new MapToolRegistry(offeredTools),
    offered,
    warnings,
    withheldForApproval,
  };
});
