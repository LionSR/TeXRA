/**
 * Agent tool resolution — single source of truth for the tools one step
 * offers.
 *
 * A step pins its tools in its session's catalog (`ToolCatalog`):
 * the tools of every plugin switched on, of the installed plugins, and of
 * the loaded plugins (MCP servers) its run holds. This module narrows
 * those to what the run may be offered, in this order:
 *   1. The declared tools, in declaration order, each with the catalog's own
 *      contract (description, parameter schema). An MCP server's tools
 *      (`mcp__<server>__<tool>`, or `mcp__<server>__*` for all it lists)
 *      come from the loaded plugin the declaration names; a server that is
 *      not configured or failed to start is reported. A tool whose plugin a
 *      dependency probe found missing, that the host cannot run (its
 *      `unavailableHosts`) or that
 *      is approval-gated while approval prompts are unavailable is withheld;
 *      so is one whose plugin is off (not pinned).
 *   2. The injected tools not already declared, under the same gates: the
 *      plugins' (`injectedWhen`), and every tool of an installed plugin (its
 *      MCP servers'), which the plugin's enablement offers every top-level
 *      tool-use run but a plugin agent that names its tools. The built-in
 *      code mode plugin's script-only functions (`self()`) come with its
 *      script tool.
 *   3. The run's own tools (caller-supplied, and the structured-output
 *      terminal tool) laid over the result: each replaces a same-named
 *      entry and wins the name in the returned registry. That registry holds
 *      the offered tools only, so dispatch cannot run a tool the model was
 *      not offered.
 *
 * A child run resolves like any other: its launcher's tools do not bound it.
 * What it may do with them is the approval policy's, which reads the launch
 * edge (`resolveBypass`).
 *
 * A switched-off plugin is withheld silently: the user chose it. Every other
 * withholding of a declared tool (a missing dependency, a host the tool does
 * not run on, a capability the host lacks) is returned as a warning, which
 * the step reports when the offered set changes, not on every step; an
 * injected tool the run never named goes quietly.
 */

import { Context, Effect, SubscriptionRef } from 'effect';

import type {
  RuntimeTool as ITool,
  RuntimeToolRegistry,
} from '@agent/runtime/ToolServices';
import { isInstalledPluginId } from '@common/plugins/pluginTrust';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingHost } from '@shared/state/stateSettings';
import {
  sameIdentity,
  type OfferedTool,
  type Persona,
  type ToolDefinition,
} from '@shared/schemas';
import { Settings } from '@shared/config/settings';
import {
  toolDigests,
  type HeldPlugins,
  type ToolEntry,
} from '@tools/catalogEntries';
import { mcpPluginId, mcpServerOfToolName } from '@tools/mcp/mcpServer';
import { builtinTools } from '@tools/plugins';
import { ToolAvailability } from '@tools/toolAvailabilityService';
import { ToolRegistry } from '@tools/toolTable';

/**
 * The host capabilities a session's host serves now (`ITool.hostCapability`
 * names one), by the session's storage root: what a plugin whose tools need
 * a host capability serves from its process layer, from the same place its
 * tools reach that capability, so it is offered exactly while it works.
 * A plugin that serves none offers its gated tools nowhere.
 */
export class HostCapabilities extends Context.Service<
  HostCapabilities,
  { readonly of: (storage: string) => ReadonlySet<string> }
>()('@texra-ai/harness/agent/HostCapabilities') {}

/** What a step resolves its tools from: fixed at the run's open, but the
 *  approval flag the step reads live. */
export interface StepToolInputs {
  readonly tools: Persona['tools'];
  /** When true, approval-gated tools are withheld: read live each step. */
  readonly approvalPromptsUnavailable: boolean;
  /** What the session's host serves now, read live each step: a tool that
   *  needs a capability missing here is withheld. */
  readonly hostCapabilities: ReadonlySet<string>;
  /** The product host the run's roots name; tools excluded from it are dropped. */
  readonly host: SettingHost;
  /** Tools only this run holds, laid over the resolved list (step 3). */
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
  /** The loaded plugins the run holds, from its open. */
  readonly held: HeldPlugins;
}

/** A declaration's tool names, in order. */
export const declaredToolNames = (tools: Persona['tools']): readonly string[] =>
  (Array.isArray(tools) ? tools : []).map((toolConfig) =>
    typeof toolConfig === 'string' ? toolConfig : toolConfig.name,
  );

/** The names the plugins inject into a step (step 2): each whose
 *  `injectedWhen` setting is on, and every tool of an installed plugin. */
const injectedNames = Effect.fn('injectedNames')(function* (
  table: ToolRegistry['Service'],
  catalog: ReadonlyMap<string, ToolEntry>,
  input: StepToolInputs,
) {
  const injected: string[] = [];
  if (input.injectTools)
    for (const { injectedWhen } of table.entries.values())
      for (const [name, setting] of Object.entries(injectedWhen ?? {}))
        if (
          setting === true ||
          (yield* Settings.get<boolean>(input.stores, setting))
        )
          injected.push(name);
  if (input.injectInstalled)
    for (const [name, entry] of catalog)
      if (isInstalledPluginId(entry.plugin)) injected.push(name);
  return injected;
});

/** Why this host withholds `tool`: a host it does not run on, or a host
 *  capability this host does not serve. */
const hostRefusal = (
  tool: ITool | undefined,
  input: StepToolInputs,
): string | undefined => {
  if (tool?.unavailableHosts?.includes(input.host))
    return `it does not run on the ${input.host} host.`;
  if (
    tool?.hostCapability !== undefined &&
    !input.hostCapabilities.has(tool.hostCapability)
  )
    return `this host does not serve "${tool.hostCapability}".`;
  return undefined;
};

/** The built-in code mode plugin's tool behind `entry`
 *  (`builtinPlugins.ts`): an app plugin that takes the id is not code mode. */
const codeModeTool = (entry: ToolEntry | undefined): ITool | undefined =>
  entry?.plugin === 'codemode' && builtinTools.has(entry.tool)
    ? entry.tool
    : undefined;
const isScript = (entry: ToolEntry | undefined): boolean =>
  codeModeTool(entry)?.describe !== undefined;

/** Resolve the tools one step offers from the catalog entries it pinned. */
export const resolveStepTools = Effect.fn('resolveStepTools')(function* (
  catalog: ReadonlyMap<string, ToolEntry>,
  input: StepToolInputs,
) {
  const table = yield* ToolRegistry;
  const warnings: string[] = [];
  const injected = yield* injectedNames(table, catalog, input);
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
    [...catalog].filter(([, e]) => !probedOff.has(e.plugin)),
  );

  // A declared MCP name reaches its server's plugin: `mcp__<server>__*` is
  // every tool the server listed, in its order. A server the run names but
  // could not get (not configured, or failed to start) is reported once.
  const reportedServers = new Set<string>();
  const reportServer = (server: string, message: string): void => {
    if (!reportedServers.has(server)) warnings.push(message);
    reportedServers.add(server);
  };
  const expandDeclared = (name: string): readonly string[] => {
    const server = mcpServerOfToolName(name);
    if (server === undefined) return [name];
    const id = mcpPluginId(server);
    // An installed plugin's server: its tools are pinned while
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
  const withheldForApproval: string[] = [];
  // A declared tool a gate withholds says so; an injected one goes quietly,
  // as the run never asked for it by name.
  const gated = (name: string, source: 'declared' | 'injected'): boolean => {
    const tool = enabled.get(name)?.tool ?? table.tools.get(name);
    const refusal = hostRefusal(tool, input);
    if (refusal !== undefined) {
      if (source === 'declared')
        warnings.push(`Declared tool "${name}" is not offered: ${refusal}`);
      return true;
    }
    if (!tool?.requiresApproval || !input.approvalPromptsUnavailable)
      return false;
    // One whose plugin is off is withheld for that, silently.
    if (enabled.has(name)) withheldForApproval.push(name);
    return true;
  };
  const offer = (name: string, source: 'declared' | 'injected'): void => {
    if (resolvedNames.has(name)) return;
    // A missing dependency says so where the run declared the tool, before
    // any other gate, so an approval-gated tool's reason is not lost to the
    // approval notice.
    const missing = probedOff.get(catalog.get(name)?.plugin ?? '');
    if (missing !== undefined) {
      if (source === 'declared')
        warnings.push(
          `Tool "${name}" is not offered: its plugin ${missing.id} is not available in this workspace${missing.statusDetail ? ` (${missing.statusDetail})` : ''}.`,
        );
      return;
    }
    if (gated(name, source)) return;
    const entry = enabled.get(name);
    if (!entry) {
      // A name with no registration is a configuration error (typo, or a
      // tool retired from the table): dropping it silently would strip the
      // agent's capability with no trace. One whose plugin is switched off
      // is withheld quietly; an MCP name was reported above.
      if (!table.tools.get(name) && mcpServerOfToolName(name) === undefined)
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
  // A script's functions come with the script tool.
  const scripted = [...resolvedNames].some((name) =>
    isScript(enabled.get(name)),
  );
  if (scripted)
    for (const [name, entry] of enabled)
      if (codeModeTool(entry)?.scriptGlobal?.withScript === true)
        offer(name, 'injected');

  const overlay = new Map<string, ITool>();
  for (const tool of input.runTools) {
    const { name } = tool.definition;
    const index = definitions.findIndex((entry) => entry.name === name);
    if (overlay.has(name) || table.tools.get(name) || index !== -1)
      warnings.push(`Run-scoped tool "${name}" shadows an existing tool.`);
    overlay.set(name, tool);
    if (index === -1) definitions.push(tool.definition);
    else definitions[index] = tool.definition;
  }
  // Which tools the requests send (`OfferedTool.sent`), recorded per tool.
  const scriptAlone =
    scripted &&
    (yield* Settings.get<boolean>(input.stores, GlobalStateKey.SCRIPT_ONLY));
  return {
    definitions,
    ...recordOffered(definitions, overlay, enabled, scriptAlone),
    warnings,
    withheldForApproval,
  };
});

/** What a step offers, as dispatch and the run's record read it: the
 *  registry holds the offered tools only, and each gets its `OfferedTool`. */
function recordOffered(
  definitions: readonly ToolDefinition[],
  overlay: ReadonlyMap<string, ITool>,
  enabled: ReadonlyMap<string, ToolEntry>,
  scriptAlone: boolean,
): { readonly registry: Map<string, ITool>; readonly offered: OfferedTool[] } {
  const registry = new Map<string, ITool>();
  const offered: OfferedTool[] = [];
  // Recorded as shown: the definition sent.
  for (const definition of definitions) {
    const { name } = definition;
    const own = overlay.get(name);
    const entry = enabled.get(name);
    if (own) {
      // A tool only this run holds; `definition` is its own.
      registry.set(name, own);
      offered.push({
        name,
        ...toolDigests(own),
        plugin: 'run',
        revision: 'run',
        sent: true,
      });
    } else if (entry) {
      registry.set(name, entry.tool);
      offered.push({
        name,
        digest: entry.digest,
        shown: toolDigests({ definition }).shown,
        plugin: entry.plugin,
        revision: entry.revision,
        sent: !scriptAlone || isScript(entry),
      });
    }
  }
  return { registry, offered };
}

/** The tools a step resolves from its pin. */
export interface ResolvedTools {
  readonly definitions: readonly ToolDefinition[];
  /** The offered tools by name: dispatch runs nothing else. */
  readonly registry: RuntimeToolRegistry;
  /** Each offered tool's identity, in offer order. */
  readonly offered: readonly OfferedTool[];
}

/** The recorded tools a resumed step may still offer, and why the rest
 *  are not offered. */
export function heldToRecord(
  resolved: ResolvedTools,
  recorded: readonly OfferedTool[],
): { readonly tools: ResolvedTools; readonly notes: string[] } {
  const current = new Map(resolved.offered.map((tool) => [tool.name, tool]));
  // The current entry, which may describe the tool anew; sent as recorded.
  const kept = recorded.flatMap((tool) => {
    const now = current.get(tool.name);
    return now !== undefined && sameIdentity(now, tool)
      ? [{ ...now, sent: tool.sent }]
      : [];
  });
  const names = new Set(kept.map(({ name }) => name));
  const notes = recorded
    .filter(({ name }) => !names.has(name))
    .map(({ name }) =>
      current.has(name)
        ? `Tool "${name}" changed since this run was offered it; the resumed run does not offer it at this step.`
        : `Tool "${name}" was offered to this run but is no longer available; the resumed run continues without it.`,
    );
  const byName = new Map(resolved.definitions.map((d) => [d.name, d]));
  return {
    tools: {
      definitions: kept.flatMap(({ name }) => byName.get(name) ?? []),
      registry: new Map(
        kept.flatMap(({ name }) => {
          const tool = resolved.registry.get(name);
          return tool ? [[name, tool] as const] : [];
        }),
      ),
      offered: kept,
    },
    notes,
  };
}
